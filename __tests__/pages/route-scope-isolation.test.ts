/**
 * Adversarial route-level multi-tenant SCOPING tests for the data routes
 * (pages/api/domains.ts, pages/api/keywords.ts, pages/api/domain.ts).
 *
 * SECURITY-CRITICAL contract under test (with MULTI_TENANT = 'true'):
 *   1. Every Domain/Keyword read a route issues for a real tenant carries
 *      { owner_id: <tenant ID> } in its where-clause, so one tenant can never
 *      read another tenant's rows. A regression that drops scopeWhere(account)
 *      from a query is caught here: the asserted where-clause would lose owner_id.
 *   2. The admin/legacy caller (ID = ADMIN_ACCOUNT_ID) is UNSCOPED: its where-clause
 *      has NO owner_id key, so legacy single-tenant data stays byte-for-byte visible.
 *   3. Creates STAMP owner_id: a tenant's bulkCreate rows carry owner_id = tenant ID;
 *      the admin's carry owner_id = null (matching legacy NULL-owner storage).
 *   4. Deletes are scoped the same way: a tenant destroy carries owner_id; admin's
 *      does not.
 *
 * The DB layer is mocked to a no-op sync, the Domain/Keyword models are mocked so
 * every call is a pure assertion on the where-clause the route built, and authorize
 * is mocked per-test to inject the calling account. This isolates the route's own
 * scoping wiring. No network, no DB.
 *
 * The helpers (scopeWhere / ownerIdFor) are NOT mocked: we want the real flag-gated
 * logic threaded through the real route, so the test proves the end-to-end contract
 * (flag on + tenant => owner_id present) rather than just re-asserting the helper.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// keywords.ts imports { Op } from 'sequelize' directly. Stub it so jest never has to
// transform sequelize's ESM uuid dependency; the models are mocked, so Op is only used
// as a unique object key in the where-clauses we assert on.
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: {
      findAll: jest.fn(), findOne: jest.fn(), destroy: jest.fn(), bulkCreate: jest.fn(),
   },
}));
jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: {
      findAll: jest.fn(), findOne: jest.fn(), destroy: jest.fn(), bulkCreate: jest.fn(), update: jest.fn(), count: jest.fn(),
   },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// Side-effecting utilities the routes import are stubbed so the handlers run pure.
jest.mock('../../utils/domains', () => ({ __esModule: true, default: jest.fn(async (d: unknown) => d) }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   checkSerchConsoleIntegration: jest.fn(async () => ({ isValid: true })),
   removeLocalSCData: jest.fn(async () => true),
   readLocalSCData: jest.fn(async () => false),
   integrateKeywordSCData: jest.fn((k: unknown) => k),
}));
jest.mock('../../utils/scraper', () => ({
   __esModule: true,
   removeFromRetryQueue: jest.fn(async () => undefined),
}));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
jest.mock('../../utils/parseKeywords', () => ({ __esModule: true, default: jest.fn((rows: unknown[]) => rows) }));
jest.mock('../../utils/adwords', () => ({
   __esModule: true,
   getKeywordsVolume: jest.fn(async () => ({ volumes: false })),
   updateKeywordsVolumeData: jest.fn(async () => undefined),
}));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({})) }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import domainsHandler from '../../pages/api/domains';
// eslint-disable-next-line import/first
import keywordsHandler from '../../pages/api/keywords';
// eslint-disable-next-line import/first
import domainHandler from '../../pages/api/domain';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as {
   findAll: jest.Mock, findOne: jest.Mock, destroy: jest.Mock, bulkCreate: jest.Mock,
};
const mockKeyword = KeywordModel as unknown as {
   findAll: jest.Mock, findOne: jest.Mock, destroy: jest.Mock, bulkCreate: jest.Mock, update: jest.Mock, count: jest.Mock,
};
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

// A plain stand-in for a sequelize row: get({plain}) returns a flat object.
const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (opts: { method?: string, body?: unknown, query?: Record<string, string> } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   body: opts.body || {},
   query: opts.query || {},
   headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/domains where-clause scoping', () => {
   it('scopes a real tenant read to its own owner_id', async () => {
      asCaller(TENANT);
      mockDomain.findAll.mockResolvedValue([]);
      await domainsHandler(makeReq({ method: 'GET' }), makeRes());

      expect(mockDomain.findAll).toHaveBeenCalledTimes(1);
      const where = mockDomain.findAll.mock.calls[0][0].where;
      expect(where).toEqual({ owner_id: TENANT.ID });
   });

   it('does NOT scope the admin read (no owner_id key)', async () => {
      asCaller(ADMIN);
      mockDomain.findAll.mockResolvedValue([]);
      await domainsHandler(makeReq({ method: 'GET' }), makeRes());

      const where = mockDomain.findAll.mock.calls[0][0].where;
      expect(where).toEqual({});
      expect(Object.prototype.hasOwnProperty.call(where, 'owner_id')).toBe(false);
   });
});

describe('POST /api/domains owner stamping', () => {
   it('stamps the tenant owner_id on every created domain row', async () => {
      asCaller(TENANT);
      mockDomain.bulkCreate.mockResolvedValue([row({ ID: 1, domain: 'a.com' })]);
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['a.com', 'b.com'] } }), makeRes());

      const created = mockDomain.bulkCreate.mock.calls[0][0] as Array<{ owner_id: unknown }>;
      expect(created).toHaveLength(2);
      created.forEach((r) => expect(r.owner_id).toBe(TENANT.ID));
   });

   it('stamps null owner_id for the admin (legacy NULL-owner storage)', async () => {
      asCaller(ADMIN);
      mockDomain.bulkCreate.mockResolvedValue([row({ ID: 1, domain: 'a.com' })]);
      await domainsHandler(makeReq({ method: 'POST', body: { domains: ['a.com'] } }), makeRes());

      const created = mockDomain.bulkCreate.mock.calls[0][0] as Array<{ owner_id: unknown }>;
      expect(created[0].owner_id).toBeNull();
   });
});

describe('DELETE /api/domains where-clause scoping', () => {
   it('scopes a tenant delete (and its keyword cleanup) to its own owner_id', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'a.com' })); // ownership pre-check passes
      mockKeyword.findAll.mockResolvedValue([]);
      mockDomain.destroy.mockResolvedValue(1);
      mockKeyword.destroy.mockResolvedValue(0);
      await domainsHandler(makeReq({ method: 'DELETE', query: { domain: 'a.com' } }), makeRes());

      // The ownership pre-check is itself scoped to the tenant.
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT.ID });

      expect(mockDomain.destroy.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT.ID });
      expect(mockKeyword.destroy.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT.ID });
      // The keyword lookup that drives retry-queue cleanup is scoped too.
      expect(mockKeyword.findAll.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT.ID });
   });

   it('does NOT scope the admin delete', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'a.com' })); // ownership pre-check passes
      mockKeyword.findAll.mockResolvedValue([]);
      mockDomain.destroy.mockResolvedValue(1);
      mockKeyword.destroy.mockResolvedValue(0);
      await domainsHandler(makeReq({ method: 'DELETE', query: { domain: 'a.com' } }), makeRes());

      expect(mockDomain.destroy.mock.calls[0][0].where).toEqual({ domain: 'a.com' });
      expect(Object.prototype.hasOwnProperty.call(mockDomain.destroy.mock.calls[0][0].where, 'owner_id')).toBe(false);
   });
});

describe('GET /api/keywords where-clause scoping', () => {
   it('scopes a tenant keyword read to its own owner_id', async () => {
      asCaller(TENANT);
      mockKeyword.findAll.mockResolvedValue([]);
      await keywordsHandler(makeReq({ method: 'GET', query: { domain: 'a.com' } }), makeRes());

      expect(mockKeyword.findAll.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT.ID });
   });

   it('does NOT scope the admin keyword read', async () => {
      asCaller(ADMIN);
      mockKeyword.findAll.mockResolvedValue([]);
      await keywordsHandler(makeReq({ method: 'GET', query: { domain: 'a.com' } }), makeRes());

      expect(mockKeyword.findAll.mock.calls[0][0].where).toEqual({ domain: 'a.com' });
   });
});

describe('POST /api/keywords owner stamping', () => {
   it('stamps the tenant owner_id on every created keyword row', async () => {
      asCaller(TENANT);
      mockDomain.findAll.mockResolvedValue([row({ domain: 'a.com' })]); // caller owns the domain
      mockKeyword.count.mockResolvedValue(0); // under the per-domain cap
      mockKeyword.bulkCreate.mockResolvedValue([row({ ID: 1 })]);
      const body = { keywords: [{ keyword: 'seo', device: 'desktop', country: 'US', domain: 'a.com' }] };
      await keywordsHandler(makeReq({ method: 'POST', body }), makeRes());

      expect(mockKeyword.bulkCreate.mock.calls[0][0][0].owner_id).toBe(TENANT.ID);
   });

   it('stamps null owner_id for the admin', async () => {
      asCaller(ADMIN);
      mockDomain.findAll.mockResolvedValue([row({ domain: 'a.com' })]); // domain exists (scope {} for admin)
      mockKeyword.count.mockResolvedValue(0);
      mockKeyword.bulkCreate.mockResolvedValue([row({ ID: 1 })]);
      const body = { keywords: [{ keyword: 'seo', device: 'desktop', country: 'US', domain: 'a.com' }] };
      await keywordsHandler(makeReq({ method: 'POST', body }), makeRes());

      expect(mockKeyword.bulkCreate.mock.calls[0][0][0].owner_id).toBeNull();
   });
});

describe('DELETE /api/keywords where-clause scoping', () => {
   it('scopes a tenant keyword delete to its own owner_id', async () => {
      asCaller(TENANT);
      mockKeyword.destroy.mockResolvedValue(1);
      await keywordsHandler(makeReq({ method: 'DELETE', query: { id: '5,6' } }), makeRes());

      const where = mockKeyword.destroy.mock.calls[0][0].where;
      expect(where.owner_id).toBe(TENANT.ID);
   });

   it('does NOT scope the admin keyword delete', async () => {
      asCaller(ADMIN);
      mockKeyword.destroy.mockResolvedValue(1);
      await keywordsHandler(makeReq({ method: 'DELETE', query: { id: '5,6' } }), makeRes());

      expect(Object.prototype.hasOwnProperty.call(mockKeyword.destroy.mock.calls[0][0].where, 'owner_id')).toBe(false);
   });
});

describe('GET /api/domain (single resource) where-clause scoping', () => {
   it('scopes a tenant single-domain read to its own owner_id', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue(null);
      await domainHandler(makeReq({ method: 'GET', query: { domain: 'a.com' } }), makeRes());

      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com', owner_id: TENANT.ID });
   });

   it('does NOT scope the admin single-domain read', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue(null);
      await domainHandler(makeReq({ method: 'GET', query: { domain: 'a.com' } }), makeRes());

      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com' });
   });
});
