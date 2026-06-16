/**
 * Adversarial cross-tenant ownership tests for the analytics routes that take a
 * ?domain= and read an analytics provider / CrawlerHit rather than the Domain rows
 * directly (pages/api/ai-crawlers.ts as the CrawlerHit shape, pages/api/human-traffic.ts
 * as the analytics-provider shape).
 *
 * SECURITY-CRITICAL contract under test (with MULTI_TENANT = 'true'):
 *   1. Before doing any analytics work, the route verifies the requested domain is owned
 *      by the caller via Domain.findOne({ where: { domain, ...scopeWhere(account) } }).
 *   2. The ownership lookup carries owner_id for a real tenant. So when a tenant asks
 *      about a domain it does NOT own, Domain.findOne returns null under the scoped
 *      where-clause and the route 403s WITHOUT reading any analytics data (no CrawlerHit
 *      query, no provider call). This is what stops one tenant reading another's traffic.
 *   3. The admin caller is unscoped: its ownership lookup has no owner_id key.
 *   4. When the domain IS owned, the route proceeds to the analytics read.
 *
 * The Domain model + the downstream data sources are mocked, authorize is mocked per-test
 * to inject the caller, and scopeWhere runs for real so the scoped where-clause is the
 * genuine flag-gated output. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) } }));

// ai-crawlers.ts imports { Op } from 'sequelize' directly. Stub it so jest never has to
// transform sequelize's ESM uuid dependency; the models are mocked, so Op is only used
// as a unique object key in the CrawlerHit query (which we do not assert on).
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));

jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/crawlerHit', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// Downstream analytics sources for the human-traffic shape, stubbed so a proceed path is pure.
jest.mock('../../utils/analytics', () => ({ __esModule: true, getAnalyticsProvider: jest.fn(() => ({})) }));
jest.mock('../../utils/bot-filter', () => ({
   __esModule: true,
   estimateHumanTraffic: jest.fn(async () => ({ error: null, humanVisits: 0, botVisits: 0 })),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import aiCrawlersHandler from '../../pages/api/ai-crawlers';
// eslint-disable-next-line import/first
import humanTrafficHandler from '../../pages/api/human-traffic';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import CrawlerHitModel from '../../database/models/crawlerHit';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { estimateHumanTraffic } from '../../utils/bot-filter';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock };
const mockCrawlerHit = CrawlerHitModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockEstimate = estimateHumanTraffic as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' };
const TENANT = { ID: 2, name: 'Tenant A', plan: 'free', status: 'active' };

const asCaller = (account: unknown) => { mockAuthorize.mockResolvedValue({ authorized: true, account, error: undefined }); };

const makeReq = (query: Record<string, string> = {}): NextApiRequest => ({
   method: 'GET',
   query,
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

describe('GET /api/ai-crawlers domain-ownership guard (CrawlerHit shape)', () => {
   it('403s a tenant requesting a domain it does NOT own and never reads CrawlerHit', async () => {
      asCaller(TENANT);
      // Under the tenant-scoped where-clause, the unowned domain is not found.
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await aiCrawlersHandler(makeReq({ domain: 'someone-elses.com' }), res);

      expect(res.statusCode).toBe(403);
      // The ownership lookup carried owner_id, and the analytics read never happened.
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'someone-elses.com', owner_id: TENANT.ID });
      expect(mockCrawlerHit.findAll).not.toHaveBeenCalled();
   });

   it('proceeds to the CrawlerHit read when the tenant DOES own the domain', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: TENANT.ID });
      mockCrawlerHit.findAll.mockResolvedValue([]);
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await aiCrawlersHandler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockCrawlerHit.findAll).toHaveBeenCalledTimes(1);
   });

   it('admin ownership lookup is unscoped (no owner_id key)', async () => {
      asCaller(ADMIN);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com' });
      mockCrawlerHit.findAll.mockResolvedValue([]);

      await aiCrawlersHandler(makeReq({ domain: 'a.com' }), makeRes());

      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'a.com' });
      expect(Object.prototype.hasOwnProperty.call(mockDomain.findOne.mock.calls[0][0].where, 'owner_id')).toBe(false);
   });
});

describe('GET /api/human-traffic domain-ownership guard (analytics-provider shape)', () => {
   it('403s a tenant requesting a domain it does NOT own and never calls the provider', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue(null);
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await humanTrafficHandler(makeReq({ domain: 'someone-elses.com' }), res);

      expect(res.statusCode).toBe(403);
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'someone-elses.com', owner_id: TENANT.ID });
      expect(mockEstimate).not.toHaveBeenCalled();
   });

   it('proceeds to the analytics estimate when the tenant DOES own the domain', async () => {
      asCaller(TENANT);
      mockDomain.findOne.mockResolvedValue({ ID: 7, domain: 'a.com', owner_id: TENANT.ID });
      const res = makeRes() as NextApiResponse & { statusCode: number };

      await humanTrafficHandler(makeReq({ domain: 'a.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockEstimate).toHaveBeenCalledTimes(1);
   });
});
