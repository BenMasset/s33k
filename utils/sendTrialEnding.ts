// sendTrialEnding delivers the "your s33k trial is ending soon" dunning email through the Resend HTTP
// API. It is deliberately BEST-EFFORT and side-effect-only: it NEVER throws and NEVER blocks the
// dunning sweep that calls it. If RESEND_API_KEY is unset (the common local/dev case) it skips the
// send; if the account has no decryptable email, or the send fails, it logs and returns. Mirrors the
// invite / magic-link sender contract in utils/send-invite.ts (same transport, From address, and
// branded shell), so it inherits every defense (best-effort, http(s)-only link, plain-text part, no
// <style>). Only meaningful with MULTI_TENANT on: trialing accounts only exist in the multi-tenant
// build (the single admin is always active and unlimited and is never passed here).
//
// CONTRACT: sendTrialEnding(account: Account): Promise<void>. Never rejects.

import type Account from '../database/models/account';
import { decryptEmail } from './accountEmail';
import { subscribeUrl } from './subscribeLink';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The verified sending identity, identical to the invite/magic-link sender. Overridable by env so
// prod can point at a different verified domain without a code change. Default lives on the
// invites.s33k.io subdomain, the one verified in Resend; a root-domain address would bounce.
const fromAddress = (): string => (process.env.RESEND_FROM_EMAIL || 's33k <noreply@invites.s33k.io>');

// The mono font stack used across every s33k email, so this one reads as the same product.
const MONO = "'SF Mono', ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace";

// Escape any value interpolated into the email HTML. The link is server-built here, but escaping it
// before it lands in an href / visible span is defense-in-depth and matches the invite sender.
const escapeHtml = (value: string): string => String(value || '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;');

// Assert the subscribe link is an http(s) URL before emitting it into an href, so a misconfigured
// base URL can never become a javascript:/data: link. A bad link degrades to '#'.
const safeLink = (link: string): string => {
   try {
      const u = new URL(link);
      return (u.protocol === 'https:' || u.protocol === 'http:') ? link : '#';
   } catch {
      return '#';
   }
};

// The ONE-CLICK subscribe destination for this account. resolveBaseUrl (utils/baseUrl.ts) needs a
// request and the email sender has none, so we use the header-INDEPENDENT NEXT_PUBLIC_APP_URL directly
// (the only safe base for a link built outside a request; prod always sets it, see DEPLOY.md, and we
// fall back to the known prod host so the link is never empty). subscribeUrl mints a pre-authenticated
// signed-token /api/subscribe link, so clicking the email button lands the user straight on Stripe
// Checkout with NO login. If a token cannot be minted (no SECRET) we fall back to the /welcome page.
const subscribeLinkFor = (account: Account): string => {
   const base = (process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '') || 'https://app.s33k.io';
   return subscribeUrl(account, base) || `${base}/welcome`;
};

// Whole days from now until the trial end. Floors at 0 (an already-expired trial reads "today"). A
// missing/invalid trial_ends_at returns null, which the copy renders as a generic "soon".
const daysLeft = (endsAt: Date | string | null | undefined, now = Date.now()): number | null => {
   if (!endsAt) { return null; }
   const ms = endsAt instanceof Date ? endsAt.getTime() : new Date(endsAt).getTime();
   if (!Number.isFinite(ms)) { return null; }
   const diff = ms - now;
   if (diff <= 0) { return 0; }
   return Math.ceil(diff / (24 * 60 * 60 * 1000));
};

// "in N days" / "today" / "soon", in one place so HTML and text stay in sync.
const whenPhrase = (days: number | null): string => {
   if (days === null) { return 'soon'; }
   if (days <= 0) { return 'today'; }
   if (days === 1) { return 'in 1 day'; }
   return `in ${days} days`;
};

const buildSubject = (days: number | null): string => `Your s33k free trial ends ${whenPhrase(days)}`;

const lead = (days: number | null): string => `Your s33k free trial ends ${whenPhrase(days)}. Subscribe `
   + 'now to keep your sites tracked: rank checks, traffic and analytics, and AI search visibility, all '
   + 'controlled from the LLM you already use. When the trial ends, scraping pauses and adding new data '
   + 'is locked until you subscribe.';
const cta = 'Subscribe to keep your sites running:';
const button = 'Subscribe';

const buildHtml = (days: number | null, link: string): string => {
   const safe = safeLink(link);
   return [
      `<div style="background:#fafafa;padding:32px 16px;font-family:${MONO};">`,
      '  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #111111;">',
      '    <div style="padding:14px 20px;border-bottom:1px solid #ededed;">',
      '      <span style="display:inline-block;width:8px;height:8px;background:#0a0a0a;margin-right:8px;vertical-align:middle;"></span>',
      '      <span style="font-size:15px;font-weight:700;letter-spacing:0.5px;color:#0a0a0a;vertical-align:middle;">s33k</span>',
      '    </div>',
      '    <div style="padding:28px 24px;">',
      `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 16px;">${escapeHtml(lead(days))}</p>`,
      `      <p style="font-size:14px;line-height:1.7;color:#0a0a0a;margin:0 0 22px;">${cta}</p>`,
      `      <p style="margin:0 0 22px;"><a href="${safe}" style="display:inline-block;background:#0a0a0a;`
      + `color:#ffffff;text-decoration:none;padding:12px 22px;font-family:${MONO};font-size:14px;font-weight:700;">`
      + `${button} -&gt;</a></p>`,
      '      <p style="font-size:12px;line-height:1.6;color:#737373;margin:0;">Or paste this link into your browser:<br />'
      + `<span style="color:#0a0a0a;word-break:break-all;">${escapeHtml(safe)}</span></p>`,
      '    </div>',
      '    <div style="padding:14px 20px;border-top:1px solid #ededed;font-size:11px;color:#999999;">',
      '      s33k · SEO, AI search, and analytics in one place, controlled from your LLM.',
      '    </div>',
      '  </div>',
      '</div>',
   ].join('\n');
};

const buildText = (days: number | null, link: string): string => {
   const safe = safeLink(link);
   return [
      's33k',
      '',
      lead(days),
      '',
      cta,
      '',
      `${button}: ${safe}`,
      '',
      's33k · SEO, AI search, and analytics in one place, controlled from your LLM.',
   ].join('\n');
};

// Sends the trial-ending email for one account. Never throws. Resolves to void. Skips silently when
// RESEND_API_KEY is unset or the account has no decryptable email. Logs (no secret) on a send failure.
export const sendTrialEnding = async (account: Account): Promise<void> => {
   try {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey || !apiKey.trim()) { return; }
      if (!account) { return; }
      const to = decryptEmail(account.email);
      if (!to || !to.trim()) { return; }

      const days = daysLeft(account.trial_ends_at);
      const link = subscribeLinkFor(account);

      const response = await fetch(RESEND_ENDPOINT, {
         method: 'POST',
         headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
         },
         body: JSON.stringify({
            from: fromAddress(),
            to: to.trim(),
            subject: buildSubject(days),
            html: buildHtml(days, link),
            text: buildText(days, link),
         }),
      });
      if (!response.ok) {
         const detail = await response.text().catch(() => '');
         console.error('[ERROR] Sending trial-ending email: ', response.status, detail);
      }
   } catch (error) {
      // Best-effort: a dunning email must never break the sweep. Log and move on. No secret is logged.
      console.error('[ERROR] Sending trial-ending email: ', error);
   }
};

export default sendTrialEnding;
