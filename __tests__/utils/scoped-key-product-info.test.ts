import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * SECURITY: a read-only per-domain SHARE key may read STATIC product info, and ONLY static info.
 *
 * Item 3 of the durability work let a shared viewer read "what is this product and is it safe"
 * without widening any tenant-data exposure. Two STATIC, account-independent routes were added to
 * the scoped-key allowlist:
 *   GET /api/security  -> the fixed trust facts (utils/securityFacts.ts)
 *   GET /api/help      -> the fixed product knowledge (utils/knowledge.ts)
 * Both return the SAME payload for every caller, read no req.query.domain, call no
 * resolveDomainAccess, and touch no Domain/Keyword/event/account row.
 *
 * This suite proves, through the REAL authorize() + REAL isScopedKeyAllowedRoute (no mocks of the
 * gate logic), that an admin-account share key (the dangerous shape: minted on ADMIN_ACCOUNT_ID):
 *   A. CAN GET the two new product-info routes, and
 *   B. still CANNOT GET a representative tenant-data route (/api/export) NOR any non-GET method,
 * so the allowlist widened ONLY for static info.
 *
 * The api_key + account lookups inside resolveAccount are mocked so the share key resolves for
 * real; the share key is wired ON THE ADMIN ACCOUNT, the exact dangerous shape. No network, no DB.
 */

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import { hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
// eslint-disable-next-line import/first
import { scopedKeyAllowedRoutes, isScopedKeyAllowedRoute } from '../../utils/allowedApiRoutes';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';

const mockApiKey = ApiKeyModel as unknown as { findOne: jest.Mock };
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };

const ORIGINAL_ENV = { ...process.env };

const SHARE_KEY = 's33k_admin_share_key_product_info_xyz_123';
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

const wireAdminShareKey = () => {
   mockApiKey.findOne.mockImplementation(async ({ where }: { where: { key_prefix: string } }) => {
      if (where.key_prefix === apiKeyPrefix(SHARE_KEY)) {
         return {
            ID: 77,
            account_id: ADMIN_ACCOUNT_ID,
            key_prefix: apiKeyPrefix(SHARE_KEY),
            key_hash: hashApiKey(SHARE_KEY),
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

// The two STATIC product-info routes the widening allowed.
const PRODUCT_INFO_GET = ['/api/security', '/api/help'];

describe('share key CAN read the static product-info routes', () => {
   // Static routes carry no domain, so the share key reaches them WITHOUT a ?domain= and the
   // domain-equality check does not apply (these routes ignore req.query.domain entirely).
   it.each(PRODUCT_INFO_GET)('ALLOWS GET %s with no domain param', async (url) => {
      const result = await authorize(makeReq('GET', url, {}), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
      // A scoped key is forced to member, never admin, even minted on the admin account.
      expect(result.role).toBe('member');
   });

   it.each(PRODUCT_INFO_GET)('ALLOWS GET %s even with a ?domain= present', async (url) => {
      const result = await authorize(makeReq('GET', url, { domain: SCOPED_DOMAIN }), makeRes());
      expect(result.authorized).toBe(true);
      expect(result.account!.ID).toBe(ADMIN_ACCOUNT_ID);
   });
});

describe('the widening did NOT open any tenant-data route', () => {
   // /api/export is the canonical instance-wide exfiltration route: a share key must still be denied
   // it, proving the allowlist grew only for static info.
   it('DENIES GET /api/export even WITH ?domain=<scoped> present', async () => {
      const result = await authorize(makeReq('GET', '/api/export', { domain: SCOPED_DOMAIN }), makeRes());
      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
   });

   it.each(PRODUCT_INFO_GET)('DENIES non-GET (%s as POST) on a product-info route', async (url) => {
      const result = await authorize(makeReq('POST', url, {}), makeRes());
      expect(result.authorized).toBe(false);
      expect(result.account).toBeNull();
   });
});

describe('allowlist structural guards for the product-info entries', () => {
   it('both product-info routes are present in scopedKeyAllowedRoutes as GET', () => {
      for (const url of PRODUCT_INFO_GET) {
         expect(scopedKeyAllowedRoutes).toContain(`GET:${url}`);
      }
   });

   it('isScopedKeyAllowedRoute recognizes them as GET-only', () => {
      for (const url of PRODUCT_INFO_GET) {
         expect(isScopedKeyAllowedRoute({ method: 'GET', url } as NextApiRequest)).toBe(true);
         expect(isScopedKeyAllowedRoute({ method: 'POST', url } as NextApiRequest)).toBe(false);
      }
   });

   it('export stays OUT of the allowlist (non-vacuous: the widening is scoped to static info)', () => {
      expect(scopedKeyAllowedRoutes).not.toContain('GET:/api/export');
   });
});
