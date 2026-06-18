// send-invite delivers an invite email through the Resend HTTP API. It is deliberately
// best-effort and side-effect-only: it NEVER throws and NEVER blocks the invite flow. If
// RESEND_API_KEY is unset (the common local/dev case), it skips the send and reports
// { sent: false } so the caller falls back to returning the invite link directly. If the
// send fails, the same: log, return { sent: false, error }, and let the link be the fallback.
//
// The email is intentionally plain and on-brand: who invited you, which kind of invite, and
// the single accept link. No secrets beyond the invite code (which is itself the credential
// and is meant to reach the recipient) ever appear here.

export type InviteEmailType = 'external' | 'internal' | 'share';

export type SendInviteResult = {
   sent: boolean,
   error?: string,
};

type SendInviteArgs = {
   to: string,
   acceptLink: string,
   type: InviteEmailType,
   inviterName?: string,
   // For type 'share': the domain that was shared. Surfaced in the subject + body so the
   // recipient knows which site they were given read-only access to.
   domain?: string,
   // For type 'share' ONLY: the connect details, so the email is SELF-CONTAINED. A share key is
   // minted up front (unlike an external/internal invite, whose key is minted on accept), so we
   // can hand the recipient everything they need to connect in one paste: the one-line hosted-MCP
   // command (key embedded) plus the manual S33K_BASE_URL / S33K_API_KEY fallback. When present,
   // the email renders these instead of an activation button. The key is read-only, single-domain,
   // and revocable, so it is the lowest-risk credential to deliver this way.
   connect?: { command: string, baseUrl: string, apiKey: string },
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The verified sending identity. Overridable by env so prod can point at a different domain
// without a code change. Default is noreply@invites.s33k.io: the invites.s33k.io SUBDOMAIN is the
// one verified in Resend, so the address must live on that subdomain. A root s33k.io address would
// bounce as unverified.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <noreply@invites.s33k.io>');

const buildSubject = (type: InviteEmailType, domain?: string): string => {
   if (type === 'internal') { return 'You have been added to a team on s33k'; }
   if (type === 'share') {
      return domain && domain.trim()
         ? `A site (${domain.trim()}) was shared with you on s33k`
         : 'A site was shared with you on s33k';
   }
   return 'You have been invited to s33k';
};

// Escape the three values that originate from an authenticated inviter before they are
// interpolated into the email HTML (audit area 2, low). Without this, a malicious inviter could
// inject arbitrary markup (a rewritten anchor, hidden content) into the email delivered to a
// recipient they choose, weaponizing s33k's sending domain for a phishing payload.
const escapeHtml = (value: string): string => String(value || '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;');

// The accept link is server-generated today, but assert it is an http(s) URL before emitting it
// into an href, so a non-URL value can never become a javascript:/data: link. A bad link degrades
// to '#' rather than shipping a dangerous scheme.
const safeLink = (link: string): string => {
   try {
      const u = new URL(link);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? link : '#';
   } catch {
      return '#';
   }
};

// The copy for each invite type, in one place so the HTML and plain-text builders stay in sync.
// `who` and `site` are already-escaped values; `lead`/`cta`/`button` are static strings. Kept free
// of any "open source" framing on purpose: s33k is presented as a new product, not an OSS project.
const inviteCopy = (type: InviteEmailType, who: string, site: string): { lead: string, cta: string, button: string } => {
   if (type === 'internal') {
      return {
         lead: `${who} added you as a read-only member of their s33k account.`,
         cta: 'Activate your access below to get the API key you connect to the LLM you already use.',
         button: 'Activate access',
      };
   }
   if (type === 'share') {
      return {
         lead: `${who} shared ${site} with you on s33k. You get read-only access to that one site: its SEO `
            + 'rankings, traffic and analytics, and AI search visibility, all from the LLM you already use.',
         cta: 'Activate below to connect your read-only key for this site.',
         button: 'Connect this site',
      };
   }
   return {
      lead: `${who} invited you to s33k, the one place where your SEO rankings, traffic, and AI search `
         + 'visibility live together and you control all of it from the LLM you already use.',
      cta: 'Activate your access below to get the API key you connect to the LLM you already use.',
      button: 'Activate access',
   };
};

// Branded HTML email in the s33k identity: white, near-black ink, monospace, sharp corners,
// monochrome (no accent color, matching the landing). Inline styles only (email clients strip
// <style>); the mono font stack degrades cleanly. For a share (connect present) the email is
// self-contained: it shows the one-line hosted-MCP connect command plus the manual fallback,
// so the recipient pastes one line and is done. For an invite it shows the activation button.
const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";

const codeBlock = (content: string, faint = false): string => `<pre style="margin:0;padding:13px;`
   + `background:${faint ? '#fafafa' : '#f4f4f4'};border:1px solid ${faint ? '#ededed' : '#e2e2e2'};`
   + `font-family:${MONO};font-size:12px;line-height:1.6;color:#0a0a0a;white-space:pre-wrap;`
   + `word-break:break-all;">${content}</pre>`;

const buildHtml = (type: InviteEmailType, acceptLink: string, inviterName?: string, domain?: string,
   connect?: { command: string, baseUrl: string, apiKey: string }): string => {
   const who = escapeHtml(inviterName && inviterName.trim() ? inviterName.trim() : 'Someone');
   const site = escapeHtml(domain && domain.trim() ? domain.trim() : 'a site');
   const link = safeLink(acceptLink);
   const { lead, cta, button } = inviteCopy(type, who, site);

   let middle: string[];
   if (connect) {
      const manual = `S33K_BASE_URL=${escapeHtml(connect.baseUrl)}\nS33K_API_KEY=${escapeHtml(connect.apiKey)}`;
      middle = [
         `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 14px;">To connect it, paste this `
         + `one line into your terminal in Claude Code, then ask s33k anything about ${site}.</p>`,
         `      ${codeBlock(escapeHtml(connect.command))}`,
         '      <p style="font-size:12px;line-height:1.6;color:#737373;margin:18px 0 6px;">Prefer to set it up by hand? '
         + 'Use these in your MCP client instead:</p>',
         `      ${codeBlock(manual, true)}`,
      ];
   } else {
      middle = [
         `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 22px;">${cta}</p>`,
         `      <p style="margin:0 0 22px;"><a href="${link}" style="display:inline-block;background:#0a0a0a;`
         + `color:#ffffff;text-decoration:none;padding:12px 22px;font-family:${MONO};font-size:14px;font-weight:700;">`
         + `${button} -&gt;</a></p>`,
         '      <p style="font-size:12px;line-height:1.6;color:#737373;margin:0;">Or paste this link into your browser:<br />'
         + `<span style="color:#0a0a0a;word-break:break-all;">${escapeHtml(link)}</span></p>`,
      ];
   }

   return [
      `<div style="background:#fafafa;padding:32px 16px;font-family:${MONO};">`,
      '  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #111111;">',
      '    <div style="padding:14px 20px;border-bottom:1px solid #ededed;">',
      '      <span style="display:inline-block;width:8px;height:8px;background:#0a0a0a;margin-right:8px;vertical-align:middle;"></span>',
      '      <span style="font-size:15px;font-weight:700;letter-spacing:0.5px;color:#0a0a0a;vertical-align:middle;">s33k</span>',
      '    </div>',
      '    <div style="padding:28px 24px;">',
      `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 16px;">${lead}</p>`,
      ...middle,
      '    </div>',
      '    <div style="padding:14px 20px;border-top:1px solid #ededed;font-size:11px;color:#999999;">',
      '      s33k · SEO, AI search, and analytics in one place, controlled from your LLM.',
      '    </div>',
      '  </div>',
      '</div>',
   ].join('\n');
};

// Plain-text counterpart. Always sent alongside the HTML: a text part lifts deliverability and is
// the fallback for clients that do not render HTML. Mirrors the same copy from inviteCopy.
const buildText = (type: InviteEmailType, acceptLink: string, inviterName?: string, domain?: string,
   connect?: { command: string, baseUrl: string, apiKey: string }): string => {
   const who = inviterName && inviterName.trim() ? inviterName.trim() : 'Someone';
   const site = domain && domain.trim() ? domain.trim() : 'a site';
   const link = safeLink(acceptLink);
   const { lead, cta, button } = inviteCopy(type, who, site);
   const body = connect
      ? [
         `To connect it, paste this one line into your terminal in Claude Code, then ask s33k anything about ${site}:`,
         '',
         connect.command,
         '',
         'Prefer to set it up by hand? Use these in your MCP client instead:',
         `S33K_BASE_URL=${connect.baseUrl}`,
         `S33K_API_KEY=${connect.apiKey}`,
      ]
      : [cta, '', `${button}: ${link}`];
   return [
      's33k',
      '',
      lead,
      '',
      ...body,
      '',
      's33k · SEO, AI search, and analytics in one place, controlled from your LLM.',
   ].join('\n');
};

// Sends the invite email. Resolves (never rejects) to a SendInviteResult.
export const sendInviteEmail = async (args: SendInviteArgs): Promise<SendInviteResult> => {
   const apiKey = process.env.RESEND_API_KEY;
   if (!apiKey || !apiKey.trim()) {
      // No key configured: skip the send, let the caller fall back to returning the link.
      return { sent: false };
   }
   if (!args.to || !args.to.trim()) {
      return { sent: false, error: 'No recipient email.' };
   }
   try {
      const response = await fetch(RESEND_ENDPOINT, {
         method: 'POST',
         headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
         },
         body: JSON.stringify({
            from: fromAddress(),
            to: args.to.trim(),
            subject: buildSubject(args.type, args.domain),
            html: buildHtml(args.type, args.acceptLink, args.inviterName, args.domain, args.connect),
            text: buildText(args.type, args.acceptLink, args.inviterName, args.domain, args.connect),
         }),
      });
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         console.log('[ERROR] Sending invite email: ', response.status, detail);
         return { sent: false, error: `Resend responded ${response.status}` };
      }
      return { sent: true };
   } catch (error) {
      console.log('[ERROR] Sending invite email: ', error);
      return { sent: false, error: 'Invite email send failed.' };
   }
};

export default sendInviteEmail;
