import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * SECURITY: a read-only per-domain SHARE key minted on the ADMIN account must not escalate.
 *
 * The exploit this suite kills: a share key (ApiKey.scoped_domain set) is allowed to read ONE
 * domain. But getmasset.com's share key is minted on the ADMIN account (a domain with owner_id
 * null belongs to admin), so the scoped key inherited admin scope and admin identity. The old
 * gate only checked that ?domain= matched scoped_domain. Routes that IGNORE req.query.domain
 * (export, portfolio, domains GET, account, me, invite, feature-request, waitlist, account-data,
 * refresh, onboard, share) then returned account- or INSTANCE-wide data via scopeWhere(account)
 * (which is {} for admin) and via isAdmin(account)-style gates (true for the admin id). Full
 * instance exfiltration through a one-domain read key.
 *
 * The fix has two halves, both exercised here through the REAL authorize() + REAL
 * isScopedKeyAllowedRoute (no mocks of the gate logic itself):
 *   A. POSITIVE ALLOWLIST. A scoped key is allowed ONLY on the curated set of GET routes proven
 *      to gate per-domain (isScopedKeyAllowedRoute). Every cross-domain / account / instance route
 *      is denied, EVEN WITH ?domain=<scoped> present.
 *   B. NO ADMIN IDENTITY. A scoped key resolves with role 'member' and isAdminAccount(account) is
 *      false even though its account.ID is the admin id, so the admin-only routes refuse it.
 *
 * The api_key + account lookups inside resolveAccount are mocked so the share key resolves for
 * real; the share key is wired ON THE ADMIN ACCOUNT (account_id = ADMIN_ACCOUNT_ID), which is the
 * exact dangerous shape. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import { hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
// eslint-disable-next-line import/first
import {
   scopedKeyAllowedRoutes, allowedApiRoutes, isScopedKeyAllowedRoute,
} from '../../utils/allowedApiRoutes';
// eslint-disable-next-line import/first
import { isAdminAccount, ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';

const mockApiKey = ApiKeyModel as unknown as { findOne: jest.Mock };
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

const SHARE_KEY = 's33k_admin_share_key_for_getmasset_dot_io_abc';
const SCOPED_DOMAIN = 'getmasset.com';

const makeReq = (method: string, url: string, query: Record<string, string> = {}): NextApiRequest => ({
   method,
   url,
   query,
   headers: { authorization: `Bearer ${SHARE_KEY}` },
} as unknown as NextApiRequest);

const makeRes = (): NextApiResponse => ({
   getHeader: () => undefined,
   setHeader: () => undefined,
} as unknown as NextApiResponse);

// The DANGEROUS shape: a share key minted on the ADMIN account (account_id = ADMIN_ACCOUNT_ID),
// scoped to one domain, resolving to a real active admin-id account.
const wireAdminShareKey = () => {
   mockApiKey.findOne.mockImplementation(async ({ where }: { where: { key_prefix: string } }) => {
      if (where.key_prefix === apiKeyPrefix(SHARE_KEY)) {
         return {
            ID: 99,
            account_id: ADMIN_ACCOUNT_ID,
            key_prefix: apiKeyPrefix(SHARE_KEY),
            key_hash: hashApiKey(SHARE_KEY),
            // Even if the stored role were 'admin', a scoped key must be forced to member.
            role: 'admin',
            scoped_domain: SCOPED_DOMAIN,
            revoked_at: null,
            save: jest.fn(async () => undefined),
         };
      }
      return null;
   });
   mockAccount.findOne.mockImplementation(async ({ where }: { where: { ID: number } }) => (
      { ID: where.ID, name: 'Admin', status: 'active' }
   ));
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = 'unit-test-secret';
   process.env.MULTI_TENANT = 'true';
   wireAdminShareKey();
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

// The cross-domain / account / instance routes a share key must NEVER reach, even WITH the scoped
// ?domain= present. These are the exfiltration surfaces from the adversarial review.
const FORBIDDEN_GET = [
   '/api/export',
   '/api/portfolio',
   '/api/domains',
   '/api/account',
   '/api/account-key',
   '/api/me',
   '/api/invite',
   '/api/feature-request',
   '/api/waitlist',
   '/api/share',
];

// A representative set of the per-domain read routes a share key SHOULD reach.
const ALLOWED_GET = [
   '/api/dashboard',
   '/api/human-analytics',
   '/api/aeo-roi',
   '/api/keywords',
   '/api/seo-report',
   '/api/ai-referrals',
   // Prebuilt single-domain report bundles, added to the share-key surface (verified per-domain gate).
   '/api/weekly-digest',
   '/api/executive-summary',
   '/api/competitor-visibility',
];

describe('admin-account share key is DENIED on every cross-domain/account/instance route', () => {
   it.each(FORBIDDEN_GET)('DENIES GET %s even WITH ?domain=<scoped> present', async (url) => {
      const result = await authorize(makeReq('GET', url, { domain: SCOPED_DOMAIN }), makeRes());
      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      // Nothing leaks: no account is returned, so no route body ever runs.
      expect(result.error).toBe('This Route cannot be accessed with a share key.');
   });

   // The deny must hold whether or not the domain is present (belt: it is the ROUTE, not the
   // domain mismatch, that denies). Without a domain it is still denied.
   it.each(['/api/export', '/api/portfolio', '/api/account-data', '/api/refresh', '/api/onboard'])(
      'DENIES GET %s with NO domain param', async (url) => {
         const result = await authorize(makeReq('GET', url, {}), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
      },
   );
});

describe('admin-account share key is ALLOWED on per-domain read routes (for its domain only)', () => {
   it.each(ALLOWED_GET)('ALLOWS GET %s for ?domain=<scoped>', async (url) => {
      const result = await authorize(makeReq('GET', url, { domain: SCOPED_DOMAIN }), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      // A scoped key is forced to member, never admin, even minted on the admin account.
      expect(result.role).toBe('member');
      expect(result.scopedDomain).toBe(SCOPED_DOMAIN);
   });

   it.each(ALLOWED_GET)('DENIES GET %s for a DIFFERENT domain', async (url) => {
      const result = await authorize(makeReq('GET', url, { domain: 'other-tenant.com' }), makeRes());
      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
      expect(result.error).toBe(`This key is limited to ${SCOPED_DOMAIN}.`);
   });
});

describe('admin-account share key never carries admin identity', () => {
   it('isAdminAccount(resolved account) is FALSE even though the id is the admin id', async () => {
      const result = await authorize(makeReq('GET', '/api/dashboard', { domain: SCOPED_DOMAIN }), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      // The defense-in-depth half: the privilege predicate refuses the scoped account.
      expect(isAdminAccount(result.account)).toBe(false);
   });

   it('a genuine admin (id = ADMIN_ACCOUNT_ID, not scoped) IS admin (non-vacuous control)', () => {
      // Proves isAdminAccount is not just always-false: a plain admin-id object is admin.
      expect(isAdminAccount({ ID: ADMIN_ACCOUNT_ID } as never)).toBe(true);
      expect(isAdminAccount({ ID: 2 } as never)).toBe(false);
   });
});

describe('admin-account share key is DENIED on every non-GET (read-only)', () => {
   it.each(['POST', 'PUT', 'DELETE', 'PATCH'])(
      'DENIES %s on an otherwise-allowed route', async (method) => {
         const result = await authorize(makeReq(method, '/api/keywords', { domain: SCOPED_DOMAIN }), makeRes());
         expect(result.authorized).toBe(false);
         expect(result.account).toBeNull();
         expect(result.error).toBe('Read-only member');
      },
   );
});

describe('allowlist structural guards (non-vacuous: would catch a widening regression)', () => {
   it('isScopedKeyAllowedRoute returns true ONLY for GET routes in the allowlist', () => {
      // Every allowlisted entry is recognized as GET.
      for (const entry of scopedKeyAllowedRoutes) {
         const [method, url] = entry.split(':');
         expect(method).toBe('GET');
         expect(isScopedKeyAllowedRoute({ method: 'GET', url } as NextApiRequest)).toBe(true);
         // The SAME url under a write method is never allowed.
         expect(isScopedKeyAllowedRoute({ method: 'POST', url } as NextApiRequest)).toBe(false);
      }
      // A route not in the list is denied.
      expect(isScopedKeyAllowedRoute({ method: 'GET', url: '/api/export' } as NextApiRequest)).toBe(false);
   });

   it('scopedKeyAllowedRoutes contains ONLY GET routes', () => {
      for (const entry of scopedKeyAllowedRoutes) {
         expect(entry.startsWith('GET:')).toBe(true);
      }
   });

   it('scopedKeyAllowedRoutes is a STRICT SUBSET of allowedApiRoutes', () => {
      const allowed = new Set(allowedApiRoutes);
      for (const entry of scopedKeyAllowedRoutes) {
         expect(allowed.has(entry)).toBe(true);
      }
      // Strict: there are routes a Bearer key may call that a share key may not (e.g. export).
      expect(scopedKeyAllowedRoutes.length).toBeLessThan(allowedApiRoutes.length);
   });

   it('none of the forbidden cross-domain/account/instance routes is in the allowlist', () => {
      const forbidden = [
         'GET:/api/export', 'GET:/api/portfolio', 'GET:/api/domains', 'GET:/api/account',
         'GET:/api/account-key', 'GET:/api/me', 'GET:/api/invite', 'GET:/api/feature-request',
         'GET:/api/waitlist', 'DELETE:/api/account-data',
      ];
      const list = new Set(scopedKeyAllowedRoutes);
      for (const route of forbidden) {
         expect(list.has(route)).toBe(false);
      }
      // Also the bare route names (any method) must be absent from the GET allowlist.
      for (const name of ['export', 'portfolio', 'domains', 'account', 'account-key', 'me',
         'invite', 'feature-request', 'waitlist', 'account-data']) {
         expect(list.has(`GET:/api/${name}`)).toBe(false);
      }
   });
});
