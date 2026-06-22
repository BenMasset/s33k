/**
 * ADVERSARIAL operator-data-isolation tests (the operator-no-see security change).
 *
 * THE CONTRACT (with MULTI_TENANT = 'true'): the OPERATOR / admin sentinel (ID = 1), using its
 * everyday admin key or cookie session, is NOT a master reader of every tenant's content. It is a
 * SCOPED tenant of its OWN data (the legacy owner_id IS NULL partition, where getmasset lives). So:
 *   1. The operator CANNOT read tenant A's domains, keywords, analytics summary, or events: the
 *      per-domain gate (resolveDomainAccess => Domain.findOne scoped to owner_id null) returns null
 *      for a domain owned by a real tenant, and the route 403s. The domain LIST does not include A.
 *   2. The operator CAN still read its OWN null-owner data (getmasset): the same gate resolves the
 *      null-owner row, and the read is scoped to owner_id null.
 *   3. export is scoped to owner_id null for the operator (its own partition), never all tenants.
 *
 * resolveDomainAccess / scopeWhere run FOR REAL over the mocked Domain model, so this proves the
 * genuine end-to-end gate, not a re-assertion of the helper. authorize is mocked to inject the
 * operator (admin key) or a tenant. No network, no DB. The hosted-MCP path is covered separately by
 * hosted-mcp-scope.test.ts: every hosted-MCP tool call hits these same REST routes carrying only the
 * connecting key, so the operator's key over MCP inherits exactly this scoping (CLAUDE.md section D).
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
// Routes import { Op } from 'sequelize'. Stub it so jest never transforms sequelize's ESM deps; the
// models are mocked, so Op symbols are only unique keys inside the asserted where-clauses.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { findAll: jest.fn(async () => []) } }));
jest.mock('../../database/models/invite', () => ({ __esModule: true, default: { findAll: jest.fn(async () => []) } }));
jest.mock('../../database/models/featureRequest', () => ({ __esModule: true, default: { findAll: jest.fn(async () => []) } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn(async () => []) } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// Side-effecting utilities the data routes pull in, stubbed so the handlers run pure. scraper imports
// cheerio (ESM token error in jest) and domains.ts only needs removeFromRetryQueue from it; getdomainStats
// is stubbed so the domains GET does not hit a real stats path.
jest.mock('../../utils/scraper', () => ({ __esModule: true, removeFromRetryQueue: jest.fn(async () => undefined) }));
jest.mock('../../utils/domains', () => ({ __esModule: true, default: jest.fn(async (d: unknown) => d) }));
// adwords pulls settingsStore -> the Setting sequelize model (ESM token error in jest). keywords.ts
// only needs the volume helpers from it; stub them.
jest.mock('../../utils/adwords', () => ({
   __esModule: true,
   getKeywordsVolume: jest.fn(async () => ({ volumes: false })),
   updateKeywordsVolumeData: jest.fn(async () => undefined),
}));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({})) }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   integrateKeywordSCData: jest.fn((k: unknown) => k),
   readLocalSCData: jest.fn(async () => false),
   checkSerchConsoleIntegration: jest.fn(async () => undefined),
   removeLocalSCData: jest.fn(async () => undefined),
}));
jest.mock('../../utils/analytics', () => ({
   __esModule: true,
   getAnalyticsProvider: jest.fn(() => ({ getSummary: jest.fn(async () => ({ pageviews: 0, visitors: 0 })) })),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import domainsHandler from '../../pages/api/domains';
// eslint-disable-next-line import/first
import keywordsHandler from '../../pages/api/keywords';
// eslint-disable-next-line import/first
import summaryHandler from '../../pages/api/summary';
// eslint-disable-next-line import/first
import eventsHandler from '../../pages/api/events';
// eslint-disable-next-line import/first
import exportHandler from '../../pages/api/export';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock, findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const OPERATOR = { ID: ADMIN_ACCOUNT_ID, name: 'Operator', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', status: 'active' };

const asCaller = (account: unknown) => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role: 'admin', error: undefined });
};

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.setHeader = jest.fn();
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

const makeReq = (method: string, opts: { query?: Record<string, string>, body?: unknown } = {}): NextApiRequest => ({
   method,
   query: opts.query || {},
   body: opts.body,
   headers: {},
} as unknown as NextApiRequest);

const row = (attrs: Record<string, unknown>) => ({ ...attrs, get: (k?: string) => (k ? attrs[k] : attrs) });

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // resolveDomainAccess does Domain.findOne({ where: { domain, ...scopeWhere } }). For the operator
   // that scope is { owner_id: null }; tenant A's domain has a non-null owner_id, so the operator's
   // scoped lookup returns null. The mock honors that: it returns a row ONLY when the where includes
   // owner_id null (the operator's own partition) AND the domain is the operator's own.
   mockDomain.findOne.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      // Operator-owned (null-owner) domain getmasset resolves; anything else does not for the operator.
      if (where && where.domain === 'getmasset.com' && where.owner_id === null) {
         return row({ ID: 1, domain: 'getmasset.com', owner_id: null });
      }
      return null;
   });
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('the operator cannot read another tenant\'s CONTENT under MULTI_TENANT on', () => {
   it('GET /api/summary for tenant A\'s domain is 403\'d and never reads events', async () => {
      asCaller(OPERATOR);
      const res = makeRes();
      await summaryHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(403);
      expect(mockEvent.findAll).not.toHaveBeenCalled();
      // The owner pre-check ran scoped to the operator's null-owner partition (so A's row never matched).
      expect(mockDomain.findOne.mock.calls[0][0].where).toMatchObject({ owner_id: null });
   });

   it('GET /api/events for tenant A\'s domain is 403\'d and never reads events', async () => {
      asCaller(OPERATOR);
      const res = makeRes();
      await eventsHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(403);
      expect(mockEvent.findAll).not.toHaveBeenCalled();
   });

   it('GET /api/keywords for tenant A\'s domain reads ONLY the operator\'s null-owner partition (no A rows)', async () => {
      asCaller(OPERATOR);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();
      await keywordsHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      // The keyword read is scoped to owner_id null, so even naming A's domain returns nothing of A's.
      expect(mockKeyword.findAll.mock.calls[0][0].where).toMatchObject({ domain: 'tenant-a.com', owner_id: null });
      expect(mockKeyword.findAll.mock.calls[0][0].where).not.toEqual({ domain: 'tenant-a.com' });
   });

   it('GET /api/domains lists ONLY the operator\'s null-owner domains (not tenant A\'s)', async () => {
      asCaller(OPERATOR);
      mockDomain.findAll.mockResolvedValue([row({ domain: 'getmasset.com', owner_id: null })]);
      const res = makeRes();
      await domainsHandler(makeReq('GET'), res);

      // The list query is scoped to the operator's null-owner partition, so it can never include A's.
      expect(mockDomain.findAll.mock.calls[0][0].where).toEqual({ owner_id: null });
   });

   it('GET /api/export is scoped to the operator\'s null-owner partition, never all tenants', async () => {
      asCaller(OPERATOR);
      mockDomain.findAll.mockResolvedValue([]);
      mockKeyword.findAll.mockResolvedValue([]);
      mockEvent.findAll.mockResolvedValue([]);
      const res = makeRes();
      await exportHandler(makeReq('GET'), res);

      // Every export query carries owner_id: null (the operator's own data), not an unscoped {}.
      expect(mockDomain.findAll.mock.calls[0][0].where).toEqual({ owner_id: null });
      expect(mockKeyword.findAll.mock.calls[0][0].where).toMatchObject({ owner_id: null });
      expect(mockEvent.findAll.mock.calls[0][0].where).toMatchObject({ owner_id: null });
   });
});

describe('the operator CAN still read its OWN null-owner data (getmasset)', () => {
   it('GET /api/summary for the operator\'s own domain passes the owner gate and reads events scoped to null', async () => {
      asCaller(OPERATOR);
      mockEvent.findAll.mockResolvedValue([]);
      const res = makeRes();
      await summaryHandler(makeReq('GET', { query: { domain: 'getmasset.com' } }), res);

      // The owner gate PASSED (it is not the 403 a foreign domain gets): the operator owns getmasset
      // via its null-owner partition. The event read therefore fired, scoped to owner_id null. (The
      // downstream summary math is exercised by summary's own tests; here we prove only the operator's
      // own-data read is reachable and correctly scoped, the security-relevant fact.)
      expect(res.statusCode).not.toBe(403);
      expect(mockEvent.findAll).toHaveBeenCalled();
      expect(mockEvent.findAll.mock.calls[0][0].where).toMatchObject({ domain: 'getmasset.com', owner_id: null });
   });

   it('GET /api/keywords for the operator\'s own domain returns 200 scoped to null (own data readable)', async () => {
      asCaller(OPERATOR);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();
      await keywordsHandler(makeReq('GET', { query: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockKeyword.findAll.mock.calls[0][0].where).toMatchObject({ domain: 'getmasset.com', owner_id: null });
   });
});

describe('a real tenant still reads its OWN data normally', () => {
   it('GET /api/keywords for tenant A scopes to A\'s own owner_id', async () => {
      asCaller(TENANT_A);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();
      await keywordsHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      expect(mockKeyword.findAll.mock.calls[0][0].where).toMatchObject({ domain: 'tenant-a.com', owner_id: TENANT_A.ID });
   });
});

describe('flag-OFF single-tenant: the operator legitimately reads everything (unscoped)', () => {
   it('GET /api/keywords with MULTI_TENANT off has NO owner_id key (byte-for-byte single-tenant)', async () => {
      process.env.MULTI_TENANT = 'false';
      asCaller(OPERATOR);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();
      await keywordsHandler(makeReq('GET', { query: { domain: 'anything.com' } }), res);

      const where = mockKeyword.findAll.mock.calls[0][0].where;
      expect(Object.prototype.hasOwnProperty.call(where, 'owner_id')).toBe(false);
      expect(where).toEqual({ domain: 'anything.com' });
   });
});
