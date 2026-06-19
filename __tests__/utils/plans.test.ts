/**
 * Unit tests for utils/plans.ts: the per-unit billing caps + active-account resolution.
 *
 * Pure functions, no DB, no network. We toggle MULTI_TENANT via process.env (read live by
 * isMultiTenantEnabled) and pass plain account-shaped objects.
 *
 * MODEL: $7 per SITE, 50 keywords per site, weekly rank checks, quantity = number of sites.
 *
 * Contracts under test:
 *   capsForSites:
 *     - keywords = 50 * sites, cadenceDays = 7, sites = sites.
 *   isAccountActive (UNCHANGED from the tiered build):
 *     - MULTI_TENANT off  -> always true (single-tenant).
 *     - admin sentinel    -> always true.
 *     - trialing + future trial_ends_at -> true; trialing + past -> false.
 *     - active -> true; canceled / past_due / incomplete / null -> false.
 *   resolveCaps:
 *     - trialing-not-expired -> capsForSites(1): 1 site / 50 keywords / weekly.
 *     - active -> capsForSites(paid_sites || 1): 50 * paid_sites keywords / weekly.
 *     - expired trial / canceled / past_due -> LOCKED_CAPS (keywords 0).
 *     - MULTI_TENANT off / admin -> very-high unlimited caps.
 */

import {
   isAccountActive, resolveCaps, capsForSites, LOCKED_CAPS,
   KEYWORDS_PER_SITE, WEEKLY_CADENCE_DAYS, TRIAL_SITES,
} from '../../utils/plans';
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

const ORIGINAL_ENV = { ...process.env };

const NOW = 1_700_000_000_000;
const future = new Date(NOW + 5 * 24 * 60 * 60 * 1000);
const past = new Date(NOW - 5 * 24 * 60 * 60 * 1000);

type Acct = {
   ID: number, plan?: string | null, subscription_status?: string | null,
   trial_ends_at?: Date | null, paid_sites?: number | null,
};
const acct = (over: Partial<Acct>): Acct => ({ ID: 2, ...over });

beforeEach(() => { process.env = { ...ORIGINAL_ENV }; process.env.MULTI_TENANT = 'true'; });
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('capsForSites', () => {
   it('is 50 keywords per site, weekly cadence', () => {
      expect(capsForSites(1)).toMatchObject({ sites: 1, keywords: 50, cadenceDays: WEEKLY_CADENCE_DAYS });
      expect(capsForSites(3)).toMatchObject({ sites: 3, keywords: 150, cadenceDays: 7 });
      expect(capsForSites(10).keywords).toBe(KEYWORDS_PER_SITE * 10);
   });

   it('floors to at least 1 site for a non-positive / garbage count', () => {
      expect(capsForSites(0).sites).toBe(1);
      expect(capsForSites(-5).sites).toBe(1);
      expect(capsForSites(Number.NaN).sites).toBe(1);
   });
});

describe('isAccountActive', () => {
   it('is always true when MULTI_TENANT is off, regardless of subscription state', () => {
      delete process.env.MULTI_TENANT;
      expect(isAccountActive(acct({ subscription_status: 'canceled', trial_ends_at: past }) as never, NOW)).toBe(true);
   });

   it('is always true for the admin sentinel account', () => {
      expect(isAccountActive({ ID: ADMIN_ACCOUNT_ID } as never, NOW)).toBe(true);
   });

   it('is true for a trialing account whose trial is in the future', () => {
      expect(isAccountActive(acct({ subscription_status: 'trialing', trial_ends_at: future }) as never, NOW)).toBe(true);
   });

   it('is false for a trialing account whose trial has expired', () => {
      expect(isAccountActive(acct({ subscription_status: 'trialing', trial_ends_at: past }) as never, NOW)).toBe(false);
   });

   it('is true for an active subscription', () => {
      expect(isAccountActive(acct({ subscription_status: 'active' }) as never, NOW)).toBe(true);
   });

   it('is false for canceled, past_due, incomplete, and null subscription_status', () => {
      expect(isAccountActive(acct({ subscription_status: 'canceled' }) as never, NOW)).toBe(false);
      expect(isAccountActive(acct({ subscription_status: 'past_due' }) as never, NOW)).toBe(false);
      expect(isAccountActive(acct({ subscription_status: 'incomplete' }) as never, NOW)).toBe(false);
      expect(isAccountActive(acct({ subscription_status: null }) as never, NOW)).toBe(false);
   });

   it('is false for a null account (flag on)', () => {
      expect(isAccountActive(null, NOW)).toBe(false);
   });
});

describe('resolveCaps', () => {
   it('returns the TRIAL caps (1 site / 50 keywords / weekly) while trialing and not expired', () => {
      const caps = resolveCaps(acct({ subscription_status: 'trialing', trial_ends_at: future }) as never, NOW);
      expect(caps).toEqual(capsForSites(TRIAL_SITES));
      expect(caps.keywords).toBe(50);
      expect(caps.sites).toBe(1);
      expect(caps.cadenceDays).toBe(7);
   });

   it('returns 50 * paid_sites keywords when active', () => {
      expect(resolveCaps(acct({ subscription_status: 'active', paid_sites: 1 }) as never, NOW)).toEqual(capsForSites(1));
      expect(resolveCaps(acct({ subscription_status: 'active', paid_sites: 4 }) as never, NOW)).toEqual(capsForSites(4));
      expect(resolveCaps(acct({ subscription_status: 'active', paid_sites: 4 }) as never, NOW).keywords).toBe(200);
   });

   it('falls back to 1 site for an active sub before paid_sites has propagated (never locks a payer out)', () => {
      expect(resolveCaps(acct({ subscription_status: 'active', paid_sites: null }) as never, NOW)).toEqual(capsForSites(1));
      expect(resolveCaps(acct({ subscription_status: 'active' }) as never, NOW)).toEqual(capsForSites(1));
   });

   it('returns LOCKED_CAPS for an expired trial', () => {
      expect(resolveCaps(acct({ subscription_status: 'trialing', trial_ends_at: past }) as never, NOW)).toEqual(LOCKED_CAPS);
      expect(LOCKED_CAPS.keywords).toBe(0);
      expect(LOCKED_CAPS.sites).toBe(0);
   });

   it('returns LOCKED_CAPS for canceled and past_due', () => {
      expect(resolveCaps(acct({ subscription_status: 'canceled' }) as never, NOW)).toEqual(LOCKED_CAPS);
      expect(resolveCaps(acct({ subscription_status: 'past_due' }) as never, NOW)).toEqual(LOCKED_CAPS);
   });

   it('returns very-high unlimited caps for the admin sentinel and when MULTI_TENANT is off', () => {
      const adminCaps = resolveCaps({ ID: ADMIN_ACCOUNT_ID } as never, NOW);
      expect(adminCaps.keywords).toBeGreaterThanOrEqual(KEYWORDS_PER_SITE * 100000);
      expect(adminCaps.cadenceDays).toBe(WEEKLY_CADENCE_DAYS);
      delete process.env.MULTI_TENANT;
      const offCaps = resolveCaps(acct({ subscription_status: 'canceled' }) as never, NOW);
      expect(offCaps.keywords).toBeGreaterThanOrEqual(KEYWORDS_PER_SITE * 100000);
   });
});
