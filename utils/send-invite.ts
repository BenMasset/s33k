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
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The verified sending identity. Overridable by env so prod can point at a real domain
// without a code change; the default is a sensible on-brand placeholder for s33k.io.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <invites@s33k.io>');

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

const buildHtml = (type: InviteEmailType, acceptLink: string, inviterName?: string, domain?: string): string => {
   const who = escapeHtml(inviterName && inviterName.trim() ? inviterName.trim() : 'Someone');
   const site = escapeHtml(domain && domain.trim() ? domain.trim() : 'a site');
   const link = safeLink(acceptLink);
   let lead: string;
   let cta: string;
   if (type === 'internal') {
      lead = `${who} added you as a read-only member of their s33k account.`;
      cta = 'Click below to activate your access and get your API key for your LLM of choice.';
   } else if (type === 'share') {
      lead = `${who} shared ${site} with you on s33k. You get read-only access to that one site's SEO rankings, `
         + 'analytics, and AI visibility, all controllable from your LLM of choice over MCP.';
      cta = 'Use the instructions below to connect your read-only key for this site.';
   } else {
      lead = `${who} invited you to s33k, the open, MCP-controllable SEO, AEO, and analytics suite.`;
      cta = 'Click below to activate your access and get your API key for your LLM of choice.';
   }
   return [
      '<div style="font-family: ui-sans-serif, system-ui, sans-serif; color: #0A0F1E; line-height: 1.6;">',
      `  <p style="font-size: 16px;">${lead}</p>`,
      `  <p style="font-size: 16px;">${cta}</p>`,
      `  <p><a href="${link}" style="display: inline-block; background: #0095FF; color: #fff; `
      + 'text-decoration: none; padding: 12px 24px; border-radius: 9999px; font-weight: 500;">Open s33k</a></p>',
      `  <p style="font-size: 13px; color: #737373;">Or paste this link into your browser:<br />${escapeHtml(link)}</p>`,
      '</div>',
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
            html: buildHtml(args.type, args.acceptLink, args.inviterName, args.domain),
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
