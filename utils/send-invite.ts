// send-invite delivers an invite email through the Resend HTTP API. It is deliberately
// best-effort and side-effect-only: it NEVER throws and NEVER blocks the invite flow. If
// RESEND_API_KEY is unset (the common local/dev case), it skips the send and reports
// { sent: false } so the caller falls back to returning the invite link directly. If the
// send fails, the same: log, return { sent: false, error }, and let the link be the fallback.
//
// The email is intentionally plain and on-brand: who invited you, which kind of invite, and
// the single accept link. No secrets beyond the invite code (which is itself the credential
// and is meant to reach the recipient) ever appear here.

export type InviteEmailType = 'external' | 'internal';

export type SendInviteResult = {
   sent: boolean,
   error?: string,
};

type SendInviteArgs = {
   to: string,
   acceptLink: string,
   type: InviteEmailType,
   inviterName?: string,
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The verified sending identity. Overridable by env so prod can point at a real domain
// without a code change; the default is a sensible on-brand placeholder for s33k.io.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <invites@s33k.io>');

const buildSubject = (type: InviteEmailType): string => (
   type === 'internal'
      ? 'You have been added to a team on s33k'
      : 'You have been invited to s33k'
);

const buildHtml = (type: InviteEmailType, acceptLink: string, inviterName?: string): string => {
   const who = inviterName && inviterName.trim() ? inviterName.trim() : 'Someone';
   const lead = type === 'internal'
      ? `${who} added you as a read-only member of their s33k account.`
      : `${who} invited you to s33k, the open, MCP-controllable SEO, AEO, and analytics suite.`;
   return [
      '<div style="font-family: ui-sans-serif, system-ui, sans-serif; color: #0A0F1E; line-height: 1.6;">',
      `  <p style="font-size: 16px;">${lead}</p>`,
      '  <p style="font-size: 16px;">Click below to activate your access and get your API key for your LLM of choice.</p>',
      `  <p><a href="${acceptLink}" style="display: inline-block; background: #0095FF; color: #fff; `
      + 'text-decoration: none; padding: 12px 24px; border-radius: 9999px; font-weight: 500;">Accept invite</a></p>',
      `  <p style="font-size: 13px; color: #737373;">Or paste this link into your browser:<br />${acceptLink}</p>`,
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
            subject: buildSubject(args.type),
            html: buildHtml(args.type, args.acceptLink, args.inviterName),
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
