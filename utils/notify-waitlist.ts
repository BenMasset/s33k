// notify-waitlist does the two side effects that turn a raw waitlist row into a real
// "request access" signal: it emails the s33k owner the new request, and it adds the requester
// to a Resend segment so the owner can see and broadcast to everyone who has asked for access.
// Like send-invite and notify-feature-request, BOTH effects are deliberately best-effort and
// side-effect-only: neither throws and neither blocks the waitlist write. If RESEND_API_KEY is
// unset (the common local/dev case) both no-op. The row is already persisted before this runs,
// so a failed email or a failed contact-add never costs the user their place in line.
//
// It carries no secret: just the requester's own email (which they typed to get a reply) plus
// the optional domain/note they submitted.

export type WaitlistNotifyResult = {
   emailed: boolean,
   segmented: boolean,
   error?: string,
};

type WaitlistNotifyArgs = {
   email: string,
   domain?: string | null,
   note?: string | null,
};

const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_CONTACTS_ENDPOINT = 'https://api.resend.com/contacts';

// The verified sending identity, shared with the invite mailer's default and overridable by env.
// invites.s33k.io is the verified Resend subdomain, so the from-address must live on it.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <noreply@invites.s33k.io>');

// Where the new-request notification lands. Defaults to the owner inbox; overridable without a
// code change.
const notifyEmail = (): string => (process.env.WAITLIST_NOTIFY_EMAIL || 'ben@getmasset.com');

// The Resend segment that collects everyone who has requested access. Defaults to the
// "s33k Access Requests" segment; overridable by env so a different instance can point elsewhere.
const requestsSegmentId = (): string => (process.env.WAITLIST_SEGMENT_ID || 'f8700fdf-e7be-40d5-a50e-d0c48c0c56f2');

const escapeHtml = (value: string): string => String(value || '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;');

const buildHtml = (args: WaitlistNotifyArgs): string => {
   const rows: string[] = [
      `  <p style="font-size: 16px;"><strong>${escapeHtml(args.email.trim())}</strong> requested access to s33k.</p>`,
   ];
   if (args.domain && args.domain.trim()) {
      rows.push(`  <p style="font-size: 14px; color: #737373;"><strong>Site:</strong> ${escapeHtml(args.domain.trim())}</p>`);
   }
   if (args.note && args.note.trim()) {
      rows.push(`  <p style="font-size: 14px; color: #737373;"><strong>Note:</strong> ${escapeHtml(args.note.trim())}</p>`);
   }
   rows.push('  <p style="font-size: 13px; color: #737373;">They are in the waitlist table and the "s33k Access Requests" Resend segment.</p>');
   return [
      '<div style="font-family: ui-sans-serif, system-ui, sans-serif; color: #0A0F1E; line-height: 1.6;">',
      '  <p style="font-size: 16px;"><strong>New s33k access request</strong></p>',
      ...rows,
      '</div>',
   ].join('\n');
};

// Emails the owner the new request. Resolves (never rejects).
const sendOwnerEmail = async (apiKey: string, args: WaitlistNotifyArgs): Promise<boolean> => {
   try {
      const response = await fetch(RESEND_EMAIL_ENDPOINT, {
         method: 'POST',
         headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
         body: JSON.stringify({
            from: fromAddress(),
            to: notifyEmail(),
            subject: `New s33k access request: ${args.email.trim()}`,
            html: buildHtml(args),
         }),
      });
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         console.error('[ERROR] Sending waitlist notify email: ', response.status, detail);
         return false;
      }
      return true;
   } catch (error) {
      console.error('[ERROR] Sending waitlist notify email: ', error);
      return false;
   }
};

// Adds the requester to the Resend "s33k Access Requests" segment. Resolves (never rejects).
// Resend's create-contact is idempotent on email within the account, so a repeat is harmless.
const addToSegment = async (apiKey: string, email: string): Promise<boolean> => {
   try {
      const response = await fetch(RESEND_CONTACTS_ENDPOINT, {
         method: 'POST',
         headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
         body: JSON.stringify({
            email: email.trim(),
            unsubscribed: false,
            segments: [{ id: requestsSegmentId() }],
         }),
      });
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         console.error('[ERROR] Adding waitlist contact to segment: ', response.status, detail);
         return false;
      }
      return true;
   } catch (error) {
      console.error('[ERROR] Adding waitlist contact to segment: ', error);
      return false;
   }
};

// Fire both side effects. Never throws. No-ops cleanly when RESEND_API_KEY is unset.
export const notifyWaitlist = async (args: WaitlistNotifyArgs): Promise<WaitlistNotifyResult> => {
   const apiKey = process.env.RESEND_API_KEY;
   if (!apiKey || !apiKey.trim()) {
      return { emailed: false, segmented: false };
   }
   const [emailed, segmented] = await Promise.all([
      sendOwnerEmail(apiKey.trim(), args),
      addToSegment(apiKey.trim(), args.email),
   ]);
   return { emailed, segmented };
};

export default notifyWaitlist;
