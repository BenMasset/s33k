// Billing caps + the effective-caps / active-account resolution for s33k.
//
// THIS FILE IS THE SINGLE TUNABLE SOURCE OF TRUTH for the per-unit price model and the trial level.
// Change a number here and the whole product follows: the keyword-create cap (pages/api/keywords.ts),
// the cron spend-brake (pages/api/cron.ts), and the billing-status view (pages/api/billing/status.ts).
//
// THE MODEL (per-unit, no named tiers):
//   - Pricing is $7 per SITE per month. Each site includes 50 tracked keywords (KEYWORDS_PER_SITE).
//   - It is QUANTITY-BASED: ONE Stripe recurring price, and the subscription QUANTITY = the number of
//     sites. Adding a site is just quantity + 1 (another $7, another 50 keywords). No tiers.
//   - Rank checks are WEEKLY for everyone (cadenceDays = 7), the COGS lever Ben chose.
//   - A 14-day NO-credit-card trial grants 1 site + 50 keywords (TRIAL_SITES).
//   - Effective caps for a paying account: sites = paid_sites, keywords = 50 * paid_sites,
//     cadenceDays = 7. An expired-trial / canceled / past_due account is LOCKED (0 keywords, 0 sites,
//     scraping paused). READS stay allowed so the app can show an upgrade prompt.
//
// Gating is only meaningful with MULTI_TENANT on; the flag-off / admin path is always active and
// unlimited. Stripe prices live in env (utils/stripe.ts), NOT here: this file is import-safe with no
// secrets and is pulled into both API routes and jest, so it must stay dependency-free of the Stripe SDK.

import type Account from '../database/models/account';
import { isMultiTenantEnabled, ADMIN_ACCOUNT_ID } from './scope';

// Keywords included per purchased site. The per-site keyword allowance AND, multiplied by paid_sites,
// the account-wide keyword cap. The hard COGS lever (each tracked keyword is a recurring SERP scrape).
export const KEYWORDS_PER_SITE = 50;

// Rank-check cadence for everyone: weekly. The chosen COGS lever (lower = fresher = costlier). There
// are no per-plan cadences anymore; this is the single value resolveCaps hands back for every account.
export const WEEKLY_CADENCE_DAYS = 7;

// Sites granted during the 14-day no-credit-card trial: 1 site, so 1 * KEYWORDS_PER_SITE = 50 keywords.
export const TRIAL_SITES = 1;

// Average weekly rank checks in a month (~4.3 weeks). Used only to project monthlyCheckBudget for the
// cost view; gating uses keywords + cadenceDays, not this number.
const WEEKLY_CHECKS_PER_MONTH = 4.3;

// A generous monthly analytics pageview allowance per purchased site. Informational for the status
// view; analytics ingestion is not hard-capped on it.
const PAGEVIEWS_PER_SITE = 250000;

export type PlanCaps = {
   // Max tracked keywords for the account (50 * paid sites). The hard COGS lever.
   keywords: number,
   // Max domains (sites) the account may track (= paid sites; 1 while trialing).
   sites: number,
   // Days between scheduled rank refreshes. Always WEEKLY_CADENCE_DAYS (7) for a billed account.
   cadenceDays: number,
   // Soft monthly ceiling on SERP checks (keywords x weekly-checks/month), used for cost projection.
   monthlyCheckBudget: number,
   // Monthly analytics pageviews included.
   pageviews: number,
};

// capsForSites derives the effective caps for a given number of purchased sites. ONE place that turns
// a site count into the full caps object, so the trial (1 site) and any paid quantity share the math.
export const capsForSites = (sites: number): PlanCaps => {
   const safeSites = Number.isFinite(sites) && sites > 0 ? Math.floor(sites) : 1;
   const keywords = KEYWORDS_PER_SITE * safeSites;
   return {
      sites: safeSites,
      keywords,
      cadenceDays: WEEKLY_CADENCE_DAYS,
      monthlyCheckBudget: Math.ceil(keywords * WEEKLY_CHECKS_PER_MONTH),
      pageviews: PAGEVIEWS_PER_SITE * safeSites,
   };
};

// The LOCKED caps applied to an inactive account (expired trial with no active sub, canceled,
// past_due). No new keywords may be added and scraping is paused; reads are still allowed elsewhere.
export const LOCKED_CAPS: PlanCaps = { keywords: 0, sites: 0, cadenceDays: 99, monthlyCheckBudget: 0, pageviews: 0 };

// The very-high caps handed to the single-tenant operator / admin sentinel (MULTI_TENANT off), so it
// is never bounded by billing. A large effective-unlimited site count.
const UNLIMITED_SITES = 100000;
const UNLIMITED_CAPS: PlanCaps = capsForSites(UNLIMITED_SITES);

// True only for the seeded admin / single-tenant sentinel account, which is ALWAYS active and
// unlimited (it is the home for legacy single-tenant data; billing never applies to it). The
// admin sentinel resolved by the legacy key/cookie is a bare { ID } with no subscription fields,
// so we key on the id, not on any billing column.
const isAdminAccountId = (account: Account | null | undefined): boolean => Boolean(
   account && account.ID === ADMIN_ACCOUNT_ID,
);

// Parse a possibly-string/Date trial_ends_at into epoch ms, or null when absent/invalid.
const toMs = (value: Date | string | null | undefined): number | null => {
   if (!value) { return null; }
   const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
   return Number.isFinite(ms) ? ms : null;
};

// isAccountActive is the single gate used everywhere billing matters (keyword-create, cron skip,
// the status view). An account is ACTIVE when:
//   - MULTI_TENANT is off (single-tenant: always active), OR
//   - it is the admin sentinel (always active), OR
//   - subscription_status === 'active', OR
//   - subscription_status === 'trialing' AND trial_ends_at is in the future.
// Everything else (expired trial, canceled, past_due, incomplete, null) is INACTIVE / locked.
// KEPT EXACTLY AS BEFORE: the per-unit move did not change what "active" means.
export const isAccountActive = (account: Account | null | undefined, now = Date.now()): boolean => {
   if (!isMultiTenantEnabled()) { return true; }
   if (isAdminAccountId(account)) { return true; }
   if (!account) { return false; }
   const status = account.subscription_status;
   if (status === 'active') { return true; }
   if (status === 'trialing') {
      const endsAt = toMs(account.trial_ends_at);
      return endsAt !== null && endsAt > now;
   }
   return false;
};

// resolveCaps returns the EFFECTIVE caps for an account:
//   - MULTI_TENANT off / admin sentinel -> the very-high UNLIMITED caps (never bounded by billing),
//   - trialing-and-not-expired -> capsForSites(TRIAL_SITES) (1 site / 50 keywords),
//   - active -> capsForSites(account.paid_sites || 1) (50 * the purchased site count),
//   - everything else (expired trial, canceled, past_due, incomplete, null) -> LOCKED_CAPS.
export const resolveCaps = (account: Account | null | undefined, now = Date.now()): PlanCaps => {
   if (!isMultiTenantEnabled() || isAdminAccountId(account)) { return UNLIMITED_CAPS; }
   if (!account) { return LOCKED_CAPS; }
   const status = account.subscription_status;
   if (status === 'trialing') {
      const endsAt = toMs(account.trial_ends_at);
      if (endsAt !== null && endsAt > now) { return capsForSites(TRIAL_SITES); }
      return LOCKED_CAPS;
   }
   if (status === 'active') {
      // paid_sites is the subscription quantity the webhook stamped (number of sites bought). Fall
      // back to 1 site for an active account before the quantity has propagated, so a paying account
      // is never locked out: it gets at least one site's allowance.
      const paidSites = (account.paid_sites && account.paid_sites > 0) ? account.paid_sites : 1;
      return capsForSites(paidSites);
   }
   return LOCKED_CAPS;
};
