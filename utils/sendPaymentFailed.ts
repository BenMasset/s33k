import type Account from '../database/models/account';
import { decryptEmail } from './accountEmail';

// sendPaymentFailed tells an account holder their Stripe payment failed and their sites are now
// paused until they update their card. It is fired (best-effort) from the webhook on
// invoice.payment_failed, alongside the past_due status flip (which locks the account immediately,
// not after a grace window). The whole point of the email is to
// give the user a self-serve recovery path: update the card in the billing portal, the next invoice
// succeeds, invoice.payment_succeeded re-applies the subscription, and the account auto-unlocks.
//
// BEST-EFFORT CONTRACT (load-bearing): this NEVER throws. The webhook must acknowledge Stripe with a
// 200 so Stripe stops retrying the status flip; letting an email-send failure bubble would turn a
// successful status update into a 400 + endless Stripe retries. So every failure here (no key, no
// email, a Resend error, a decrypt miss) is caught, logged tersely, and swallowed. It mirrors the
// best-effort sender contract of utils/send-invite.ts and reuses the same Resend HTTP transport.
//
// It carries NO secret: the only dynamic value is a link to this instance's billing portal page,
// which itself requires the user to be authed before it does anything. The account email is decrypted
// only to address the message and never echoed back to any caller.

export type SendPaymentFailedResult = {
   sent: boolean,
   error?: string,
};

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The verified sending identity, shared default with the invite + magic-link mailers and overridable
// by env. invites.s33k.io is the verified Resend subdomain, so the from-address must live on it.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <noreply@invites.s33k.io>');

// The link the user clicks to fix their card. We have NO request object here (the webhook is a
// server-to-server Stripe call), so we use the header-INDEPENDENT NEXT_PUBLIC_APP_URL only, the same
// source resolveBaseUrl trusts in production. The ?billing=portal hint lets the app surface the
// Stripe billing-portal entry point (POST /api/billing/portal) when the user lands authed. Falls back
// to the known prod URL so the link is never empty even if the env var is unset in a misconfigured
// environment. No host-header is ever consulted, so this link cannot be poisoned.
const portalLink = (): string => {
   const configured = process.env.NEXT_PUBLIC_APP_URL;
   const base = (configured && configured.trim())
      ? configured.trim().replace(/\/$/, '')
      : 'https://app.s33k.io';
   return `${base}/?billing=portal`;
};

const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";

const SUBJECT = 'Your s33k payment failed, update your card to restore your sites';

// HONEST COPY (must match behavior): an invoice.payment_failed flips the account to past_due, which
// isAccountActive treats as locked the SAME instant (writes 403, and the cron spend-brake drops the
// account's keywords so rank checks stop). So the sites do NOT keep running through dunning, they pause
// immediately. The copy says so plainly rather than promising a grace window the code does not give.
const LEAD = 'We could not process your latest s33k payment, so your sites are paused: rank tracking and '
   + 'checks have stopped for now. Update your card in the billing portal and your subscription resumes '
   + 'automatically on the next successful charge.';
const CTA = 'Update your card:';
const BUTTON = 'Open the billing portal';

// Assert the link is an http(s) URL before emitting it into an href, so a malformed env value can
// never become a javascript:/data: scheme. A bad link degrades to '#'. Mirrors send-invite.safeLink.
const safeLink = (link: string): string => {
   try {
      const u = new URL(link);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? link : '#';
   } catch {
      return '#';
   }
};

const escapeHtml = (value: string): string => String(value || '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;');

// Branded HTML, identical shell to the invite + magic-link emails (white surface, near-black ink,
// mono, sharp corners, the 8px dot wordmark) so the payment-failed mail reads as the same product.
const buildHtml = (link: string): string => {
   const safe = safeLink(link);
   const middle: string[] = [
      `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 22px;">${CTA}</p>`,
      `      <p style="margin:0 0 22px;"><a href="${safe}" style="display:inline-block;background:#0a0a0a;`
      + `color:#ffffff;text-decoration:none;padding:12px 22px;font-family:${MONO};font-size:14px;font-weight:700;">`
      + `${BUTTON} -&gt;</a></p>`,
      '      <p style="font-size:12px;line-height:1.6;color:#737373;margin:0;">Or paste this link into your browser:<br />'
      + `<span style="color:#0a0a0a;word-break:break-all;">${escapeHtml(safe)}</span></p>`,
   ];
   return [
      `<div style="background:#fafafa;padding:32px 16px;font-family:${MONO};">`,
      '  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #111111;">',
      '    <div style="padding:14px 20px;border-bottom:1px solid #ededed;">',
      '      <span style="display:inline-block;width:8px;height:8px;background:#0a0a0a;margin-right:8px;vertical-align:middle;"></span>',
      '      <span style="font-size:15px;font-weight:700;letter-spacing:0.5px;color:#0a0a0a;vertical-align:middle;">s33k</span>',
      '    </div>',
      '    <div style="padding:28px 24px;">',
      `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 16px;">${LEAD}</p>`,
      ...middle,
      '    </div>',
      '    <div style="padding:14px 20px;border-top:1px solid #ededed;font-size:11px;color:#999999;">',
      '      s33k · SEO, AI search, and analytics in one place, controlled from your LLM.',
      '    </div>',
      '  </div>',
      '</div>',
   ].join('\n');
};

const buildText = (link: string): string => {
   const safe = safeLink(link);
   return [
      's33k',
      '',
      LEAD,
      '',
      CTA,
      '',
      `${BUTTON}: ${safe}`,
      '',
      's33k · SEO, AI search, and analytics in one place, controlled from your LLM.',
   ].join('\n');
};

// Fire the payment-failed email. Resolves (never rejects) to a SendPaymentFailedResult. Skips when
// RESEND_API_KEY is unset (the common local/dev case) or when the account has no decryptable email
// (the seeded admin / a null-email account), logs and returns { sent: false } on any failure, and
// never throws. The Account is intentionally the only argument so the webhook can call it with the
// row it already resolved; the email is decrypted here, not passed in plaintext by the caller.
export const sendPaymentFailed = async (account: Account): Promise<void> => {
   try {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey || !apiKey.trim()) { return; }
      const to = decryptEmail(account && account.email);
      if (!to || !to.trim()) { return; }
      const link = portalLink();
      const response = await fetch(RESEND_ENDPOINT, {
         method: 'POST',
         headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
         },
         body: JSON.stringify({
            from: fromAddress(),
            to: to.trim(),
            subject: SUBJECT,
            html: buildHtml(link),
            text: buildText(link),
         }),
      });
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         console.error('[ERROR] Sending payment-failed email: ', response.status, detail);
      }
   } catch (error) {
      // Best-effort: swallow everything so the webhook can still 200. Never throw.
      console.error('[ERROR] Sending payment-failed email: ', error);
   }
};

export default sendPaymentFailed;
