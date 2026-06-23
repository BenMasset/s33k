import type Account from '../database/models/account';
import { subscribeUrl } from './subscribeLink';

// ONE source of truth for the human, customer-facing billing copy used by the trial-ended wall (the
// keyword / site / onboard 403s) and the dashboard / start_here banners, so the wording can never
// drift between them. The tone is plain and reassuring: no developer jargon ("call start_checkout"),
// just "your trial ended, here is the one-click link to continue".

export const PRICE_LABEL = '$7 per site / month';

// The pay-path hint appended to every trial-ended / plan-limit message. When we can mint a one-click
// link (we have the account AND a trusted baseUrl), we give the literal pre-authenticated URL so the
// user, or their LLM relaying it, can pay in ONE click from anywhere with no login. When we cannot
// (no baseUrl in this context), we name the in-LLM path as a fallback so the LLM still knows what to do.
export const payPathHint = (account?: Account | null, baseUrl?: string | null): string => {
   const link = (account && baseUrl) ? subscribeUrl(account, baseUrl) : null;
   if (link) { return ` Subscribe and continue in one click: ${link}`; }
   return ' To continue, ask to subscribe and you will get a secure payment link (start_checkout).';
};

// Human-first message for a LOCKED account (trial expired / subscription inactive). Reads stay open;
// only tracking + new sites are paused. This is the "your trial has ended, here is the link to pay"
// wall the product promises.
export const trialEndedMessage = (account?: Account | null, baseUrl?: string | null): string => {
   const body = [
      'Your 14-day free trial has ended. Your data and reports are safe and reads still work, but rank',
      `tracking and adding sites are paused. To pick up right where you left off, subscribe to s33k (${PRICE_LABEL}).`,
   ].join(' ');
   return `${body}${payPathHint(account, baseUrl)}`;
};

// Human-first message for an ACTIVE, paying account that has hit its current plan's site/keyword
// limit and needs to add a site to track more (NOT a trial-ended lock).
export const planLimitMessage = (detail: string, account?: Account | null, baseUrl?: string | null): string => (
   `${detail} Add a site to track more.${payPathHint(account, baseUrl)}`
);
