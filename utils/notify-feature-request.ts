// notify-feature-request emails the s33k team when a user submits a feature request, through
// the Resend HTTP API. Like send-invite, it is deliberately best-effort and side-effect-only:
// it NEVER throws and NEVER blocks the request flow. It no-ops (returns { sent: false }) when
// RESEND_API_KEY or the destination FEATURE_REQUEST_NOTIFY_EMAIL is unset (the common local/dev
// case), so the request is still stored and the API still returns success; the notification is
// pure gravy. If the send fails, same: log, return { sent: false, error }, move on.
//
// It carries no secret and no PII: just the requesting account id and the user's own request
// text and optional context, which they typed precisely so a human would read it.

export type NotifyResult = {
   sent: boolean,
   error?: string,
};

type NotifyArgs = {
   accountId: number,
   request: string,
   context?: string,
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The verified sending identity, shared with the invite mailer's default and overridable by env.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <invites@s33k.io>');

const escapeHtml = (value: string): string => String(value || '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;');

const buildHtml = (args: NotifyArgs): string => {
   const ctx = args.context && args.context.trim()
      ? `<p style="font-size: 14px; color: #737373;"><strong>Context:</strong> ${escapeHtml(args.context.trim())}</p>`
      : '';
   return [
      '<div style="font-family: ui-sans-serif, system-ui, sans-serif; color: #0A0F1E; line-height: 1.6;">',
      '  <p style="font-size: 16px;"><strong>New s33k feature request</strong></p>',
      `  <p style="font-size: 16px;">${escapeHtml(args.request.trim())}</p>`,
      `  ${ctx}`,
      `  <p style="font-size: 13px; color: #737373;">From account #${args.accountId}.</p>`,
      '</div>',
   ].join('\n');
};

// Sends the notification email. Resolves (never rejects) to a NotifyResult.
export const notifyFeatureRequest = async (args: NotifyArgs): Promise<NotifyResult> => {
   const apiKey = process.env.RESEND_API_KEY;
   const to = process.env.FEATURE_REQUEST_NOTIFY_EMAIL;
   if (!apiKey || !apiKey.trim() || !to || !to.trim()) {
      // Nothing configured: skip the send. The request is already stored; this is optional.
      return { sent: false };
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
            to: to.trim(),
            subject: 'New s33k feature request',
            html: buildHtml(args),
         }),
      });
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         console.error('[ERROR] Sending feature-request email: ', response.status, detail);
         return { sent: false, error: `Resend responded ${response.status}` };
      }
      return { sent: true };
   } catch (error) {
      console.error('[ERROR] Sending feature-request email: ', error);
      return { sent: false, error: 'Feature-request email send failed.' };
   }
};

export default notifyFeatureRequest;
