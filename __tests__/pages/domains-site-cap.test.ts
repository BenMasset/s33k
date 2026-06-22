import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Billing site-cap + customer-surface field-hygiene tests for /api/domains (MULTI_TENANT = 'true').
 *
 * POST /api/domains addDomain now enforces resolveCaps(account).sites (the per-unit site ceiling),
 * mirroring the keyword cap in pages/api/keywords.ts: it counts the account's EXISTING sites plus the
 * number being added and 403s when the total would exceed the cap. A trialing account gets 1 site; an
 * active account gets paid_sites; an inactive (expired-trial / canceled) account has a 0 cap and is
 * locked out with an upgrade message. With MULTI_TENANT off / admin the caps are unlimited (no-op).
 *
 * GET /api/domains reshapes the response for the customer surface: the internal `umami_website_id`
 * column is exposed as a neutral `siteId`, and the raw Search Console blob is replaced with a boolean
 * `searchConsoleConnected` (no client_email / private_key / oauth-shaped fields are ever returned).
 *
 * No network, no DB: models are jest mocks, authorize injects the caller, side effects are stubbed.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findAll: jest.fn(), count: jest.fn(), bulkCreate: jest.fn() },
}));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn(), destroy: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/domains', () => ({ __esModule: true, default: jest.fn(async (d: unknown) => d) }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   checkSerchConsoleIntegration: jest.fn(async () => ({ isValid: true })),
   removeLocalSCData: jest.fn(async () => true),
}));
jest.mock('../../utils/scraper', () => ({ __esModule: true, removeFromRetryQueue: jest.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import domainsHandler from '../../pages/api/domains';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockDomain = DomainModel as unknown as { findAll: jest.Mock, count: jest.Mock, bulkCreate: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (opts: { method?: string, body?: unknown, query?: unknown }): NextApiRequest => ({
   method: opts.method || 'GET', url: '/api/domains', query: opts.query || {}, headers: { authorization: 'Bearer s33k_x' },
   body: opts.body, socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.setHeader = jest.fn();
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, any>, setHeader: jest.Mock };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // No canonical-colliding existing rows, and bulkCreate echoes the rows it was given.
   mockDomain.findAll.mockResolvedValue([]);
   mockDomain.bulkCreate.mockImplementation(async (rows: any[]) => rows.map((r) => ({ get: () => r, ...r })));
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/domains: billing site cap', () => {
   it('403s a TRIAL account already at its 1-site cap and never creates a domain', async () => {
      asCaller({ ID: 2, subscription_status: 'trialing', trial_ends_at: future, paid_sites: null });
      mockDomain.count.mockResolvedValue(1); // already at the trial cap of 1 site
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['second-site.com'] } }), res);
      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/Site limit reached for your plan/i);
      expect(mockDomain.bulkCreate).not.toHaveBeenCalled();
   });

   it('SUCCEEDS for a TRIAL account adding its first site (0 existing, under the 1-site cap)', async () => {
      asCaller({ ID: 2, subscription_status: 'trialing', trial_ends_at: future, paid_sites: null });
      mockDomain.count.mockResolvedValue(0); // 0 + 1 = 1 == cap, allowed
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['first-site.com'] } }), res);
      expect(res.statusCode).toBe(201);
      expect(mockDomain.bulkCreate).toHaveBeenCalledTimes(1);
   });

   it('lets an ACTIVE account add up to its paid_sites cap', async () => {
      asCaller({ ID: 2, subscription_status: 'active', paid_sites: 3 });
      mockDomain.count.mockResolvedValue(2); // 2 + 1 = 3 == cap (paid_sites), allowed
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['third-site.com'] } }), res);
      expect(res.statusCode).toBe(201);
   });

   it('403s an ACTIVE account that would push past its paid_sites cap', async () => {
      asCaller({ ID: 2, subscription_status: 'active', paid_sites: 3 });
      mockDomain.count.mockResolvedValue(3); // 3 + 1 > 3, denied
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['fourth-site.com'] } }), res);
      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/Site limit reached for your plan/i);
      expect(mockDomain.bulkCreate).not.toHaveBeenCalled();
   });

   it('403s an EXPIRED-trial (locked, 0 cap) account with a trial-ended message', async () => {
      asCaller({ ID: 2, subscription_status: 'trialing', trial_ends_at: past, paid_sites: null });
      mockDomain.count.mockResolvedValue(0);
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['any-site.com'] } }), res);
      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/trial has ended|subscription is inactive/i);
      expect(mockDomain.bulkCreate).not.toHaveBeenCalled();
   });
});

describe('POST /api/domains: admin / flag-off is unlimited (no-op cap)', () => {
   it('lets the admin sentinel add a site regardless of existing count', async () => {
      delete process.env.MULTI_TENANT; // flag off -> always active, unlimited caps
      asCaller({ ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' });
      mockDomain.count.mockResolvedValue(999); // far above any plan cap; ignored when unlimited
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['admin-site.com'] } }), res);
      expect(res.statusCode).toBe(201);
      expect(mockDomain.bulkCreate).toHaveBeenCalledTimes(1);
   });
});

describe('GET /api/domains: customer-surface field hygiene', () => {
   it('returns siteId (not umami_website_id) and a searchConsoleConnected boolean, with no credential fields', async () => {
      delete process.env.MULTI_TENANT;
      asCaller({ ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' });
      const row = {
         ID: 1, domain: 'getmasset.com', slug: 'getmasset-com',
         umami_website_id: 'abc-123',
         search_console: JSON.stringify({ property_type: 'url', url: 'https://getmasset.com', client_email: 'ENC', private_key: 'ENC' }),
      };
      mockDomain.findAll.mockResolvedValue([{ get: () => row }]);
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'GET' }), res);
      expect(res.statusCode).toBe(200);
      const out = res.payload.domains[0];
      // Renamed: siteId present, internal umami_website_id absent.
      expect(out.siteId).toBe('abc-123');
      expect(out).not.toHaveProperty('umami_website_id');
      // searchConsoleConnected boolean derived from the (now stripped) credential presence.
      expect(out.searchConsoleConnected).toBe(true);
      // No credential-shaped fields anywhere in the reshaped search_console blob.
      const sc = JSON.parse(out.search_console);
      expect(sc).not.toHaveProperty('client_email');
      expect(sc).not.toHaveProperty('private_key');
      expect(sc).not.toHaveProperty('oauth_refresh_token');
      // The non-secret config the UI needs is preserved.
      expect(sc.property_type).toBe('url');
      expect(sc.url).toBe('https://getmasset.com');
   });

   it('reports searchConsoleConnected=false and siteId=null when neither is configured', async () => {
      delete process.env.MULTI_TENANT;
      asCaller({ ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' });
      const row = { ID: 2, domain: 'fresh.com', slug: 'fresh-com', umami_website_id: null, search_console: '' };
      mockDomain.findAll.mockResolvedValue([{ get: () => row }]);
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'GET' }), res);
      expect(res.statusCode).toBe(200);
      const out = res.payload.domains[0];
      expect(out.siteId).toBeNull();
      expect(out.searchConsoleConnected).toBe(false);
   });

   it('reports searchConsoleConnected=true when only an oauth_refresh_token is present', async () => {
      delete process.env.MULTI_TENANT;
      asCaller({ ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' });
      const row = { ID: 3, domain: 'oauth.com', slug: 'oauth-com', umami_website_id: 'x', search_console: JSON.stringify({ oauth_refresh_token: 'ENC' }) };
      mockDomain.findAll.mockResolvedValue([{ get: () => row }]);
      const res = makeRes();
      await domainsHandler(makeReq({ method: 'GET' }), res);
      const out = res.payload.domains[0];
      expect(out.searchConsoleConnected).toBe(true);
      expect(JSON.parse(out.search_console)).not.toHaveProperty('oauth_refresh_token');
   });
});
