/**
 * M1 adversarial cross-tenant LEAK tests for the per-domain chokepoint routes.
 *
 * These prove the one unforgivable bug cannot happen: with MULTI_TENANT on, account B must
 * never read or mutate account A's data. The routes were refactored to gate per-domain access
 * through resolveDomainAccess(account, domain[, {write:true}]); this test simulates the
 * multi-tenant world (authorize returns tenant B; the domain/rows belong to tenant A so the
 * owner-scoped Domain.findOne returns null) and asserts the route 403s and reads/writes nothing.
 *
 * Coverage (highest-value routes):
 *   - keywords: READ (GET) and WRITE (POST add).
 *   - goals:    READ (GET list) scoped by owner_id; WRITE (POST create) owner-gated; DELETE scoped.
 *   - segments: WRITE (POST create) owner-gated.
 *   - human-analytics: an analytics READ route gated by the domain chokepoint.
 *   - member-key write rejection: authorize blocks a member key's write BEFORE the route, so a
 *     write route 401s and touches no model.
 *
 * resolveDomainAccess is NOT mocked: it runs for real over the mocked Domain model, so the test
 * proves the genuine end-to-end gate (flag on + non-owner => null => 403). scopeWhere/ownerIdFor
 * run for real too. authorize is mocked to inject the calling account/role. No network, no DB.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));

// Routes import { Op } from 'sequelize'. Stub it so jest never transforms sequelize's ESM deps;
// the models are mocked, so Op symbols are only unique keys inside the asserted where-clauses.
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') } }));

jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findOne: jest.fn(), findAll: jest.fn() },
}));
jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: { findAll: jest.fn(), bulkCreate: jest.fn(), count: jest.fn() },
}));
jest.mock('../../database/models/goal', () => ({
   __esModule: true,
   default: { findAll: jest.fn(), findOne: jest.fn(), create: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../../database/models/segment', () => ({
   __esModule: true,
   default: { findAll: jest.fn(), create: jest.fn(), destroy: jest.fn() },
}));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));

// Side-effecting utilities keywords.ts pulls in are stubbed so the handler runs pure.
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/searchConsole', () => ({
   __esModule: true,
   integrateKeywordSCData: jest.fn((k: unknown) => k),
   readLocalSCData: jest.fn(async () => false),
}));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/adwords', () => ({
   __esModule: true,
   getKeywordsVolume: jest.fn(async () => ({ volumes: false })),
   updateKeywordsVolumeData: jest.fn(async () => undefined),
}));
jest.mock('../../utils/scraper', () => ({ __esModule: true, removeFromRetryQueue: jest.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import keywordsHandler from '../../pages/api/keywords';
// eslint-disable-next-line import/first
import goalsHandler from '../../pages/api/goals';
// eslint-disable-next-line import/first
import segmentsHandler from '../../pages/api/segments';
// eslint-disable-next-line import/first
import humanAnalyticsHandler from '../../pages/api/human-analytics';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import SegmentModel from '../../database/models/segment';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock, findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock, bulkCreate: jest.Mock, count: jest.Mock };
const mockGoal = GoalModel as unknown as { findAll: jest.Mock, findOne: jest.Mock, create: jest.Mock, destroy: jest.Mock };
const mockSegment = SegmentModel as unknown as { findAll: jest.Mock, create: jest.Mock, destroy: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };

const ADMIN = { ID: ADMIN_ACCOUNT_ID, name: 'Admin', status: 'active' };
const TENANT_A = { ID: 2, name: 'Tenant A', status: 'active' };
const TENANT_B = { ID: 3, name: 'Tenant B', status: 'active' };

const asCaller = (account: unknown, role: 'admin' | 'member' = 'admin') => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role, error: undefined });
};
// authorize() itself rejects a member key's write before the route runs. Simulate that exact
// shape (this is what authorize returns for a member POST/PUT/DELETE).
const asRejectedMemberWrite = () => {
   mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Read-only member' });
};

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

const makeReq = (method: string, opts: { query?: Record<string, string>, body?: unknown } = {}): NextApiRequest => ({
   method,
   query: opts.query || {},
   body: opts.body,
   headers: {},
} as unknown as NextApiRequest);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // The default for the cross-tenant case: B asks about A's domain, so the owner-scoped
   // ownership lookups return nothing. findOne => null (single-domain gate); findAll => []
   // (the keywords.ts add path checks ownership of every requested domain via findAll).
   mockDomain.findOne.mockResolvedValue(null);
   mockDomain.findAll.mockResolvedValue([]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('keywords route cross-tenant isolation', () => {
   it('READ: tenant B reading tenant A\'s domain gets nothing (no keyword read for the unowned domain)', async () => {
      // keywords GET does not have a Domain ownership pre-gate; it scopes the Keyword read by
      // owner_id, so B\'s read of A\'s domain returns ONLY rows owned by B (none here).
      asCaller(TENANT_B);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();

      await keywordsHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockKeyword.findAll.mock.calls[0][0].where).toEqual({ domain: 'tenant-a.com', owner_id: TENANT_B.ID });
   });

   it('WRITE: tenant B adding keywords to tenant A\'s domain is 403\'d and nothing is created', async () => {
      asCaller(TENANT_B);
      const res = makeRes();

      await keywordsHandler(makeReq('POST', {
         body: { keywords: [{ keyword: 'x', device: 'desktop', country: 'US', domain: 'tenant-a.com' }] },
      }), res);

      expect(res.statusCode).toBe(403);
      // The owner-scoped ownership lookup is what denies B; no row is inserted.
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
      expect(mockDomain.findAll.mock.calls[0][0].where).toMatchObject({ owner_id: TENANT_B.ID });
   });
});

describe('goals route cross-tenant isolation', () => {
   it('READ: tenant B\'s goal list is owner-scoped (cannot see tenant A\'s goals)', async () => {
      asCaller(TENANT_B);
      mockGoal.findAll.mockResolvedValue([]);
      const res = makeRes();

      await goalsHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockGoal.findAll.mock.calls[0][0].where).toEqual({ domain: 'tenant-a.com', owner_id: TENANT_B.ID });
   });

   it('WRITE: tenant B creating a goal on tenant A\'s domain is 403\'d and nothing is created', async () => {
      asCaller(TENANT_B);
      const res = makeRes();

      await goalsHandler(makeReq('POST', {
         body: { domain: 'tenant-a.com', name: 'Signup', matchValue: '/thanks' },
      }), res);

      expect(res.statusCode).toBe(403);
      expect(mockGoal.create).not.toHaveBeenCalled();
      // The write gate ran owner-scoped.
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'tenant-a.com', owner_id: TENANT_B.ID });
   });

   it('DELETE: tenant B deleting by id is owner-scoped (a foreign id deletes 0 rows)', async () => {
      asCaller(TENANT_B);
      mockGoal.destroy.mockResolvedValue(0);
      const res = makeRes();

      await goalsHandler(makeReq('DELETE', { query: { id: '999' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockGoal.destroy.mock.calls[0][0].where).toEqual({ ID: 999, owner_id: TENANT_B.ID });
      expect(res.payload.removed).toBe(0);
   });
});

describe('segments route cross-tenant isolation', () => {
   it('WRITE: tenant B creating a segment on tenant A\'s domain is 403\'d and nothing is created', async () => {
      asCaller(TENANT_B);
      const res = makeRes();

      await segmentsHandler(makeReq('POST', {
         body: { domain: 'tenant-a.com', name: 'Mobile', filters: { device: 'mobile' } },
      }), res);

      expect(res.statusCode).toBe(403);
      expect(mockSegment.create).not.toHaveBeenCalled();
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'tenant-a.com', owner_id: TENANT_B.ID });
   });
});

describe('human-analytics route cross-tenant isolation', () => {
   it('tenant B requesting tenant A\'s domain is 403\'d and the event store is NEVER read', async () => {
      asCaller(TENANT_B);
      const res = makeRes();

      await humanAnalyticsHandler(makeReq('GET', { query: { domain: 'tenant-a.com' } }), res);

      expect(res.statusCode).toBe(403);
      expect(mockEvent.findAll).not.toHaveBeenCalled();
      expect(mockDomain.findOne.mock.calls[0][0].where).toEqual({ domain: 'tenant-a.com', owner_id: TENANT_B.ID });
   });

   it('when tenant B DOES own the domain, the event read is owner-scoped too (defense in depth)', async () => {
      asCaller(TENANT_B);
      mockDomain.findOne.mockResolvedValue({ ID: 9, domain: 'tenant-b.com', owner_id: TENANT_B.ID });
      mockEvent.findAll.mockResolvedValue([]);
      const res = makeRes();

      await humanAnalyticsHandler(makeReq('GET', { query: { domain: 'tenant-b.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(mockEvent.findAll.mock.calls[0][0].where).toMatchObject({ domain: 'tenant-b.com', owner_id: TENANT_B.ID });
   });
});

describe('admin (single-tenant / legacy) stays unscoped', () => {
   it('admin keyword read has no owner_id key', async () => {
      asCaller(ADMIN);
      mockKeyword.findAll.mockResolvedValue([]);
      const res = makeRes();

      await keywordsHandler(makeReq('GET', { query: { domain: 'getmasset.com' } }), res);

      expect(res.statusCode).toBe(200);
      expect(Object.prototype.hasOwnProperty.call(mockKeyword.findAll.mock.calls[0][0].where, 'owner_id')).toBe(false);
   });
});

describe('member-key write rejection (authorize gate, pinned at the route)', () => {
   it.each([
      ['keywords', keywordsHandler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<unknown>],
      ['goals', goalsHandler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<unknown>],
      ['segments', segmentsHandler as unknown as (r: NextApiRequest, s: NextApiResponse) => Promise<unknown>],
   ])('%s POST from a member key is blocked before the route and creates nothing', async (_name, handler) => {
      asRejectedMemberWrite();
      const res = makeRes();

      await handler(makeReq('POST', { body: { domain: 'tenant-a.com', name: 'x', matchValue: '/y', filters: { device: 'mobile' } } }), res);

      expect(res.statusCode).toBe(401);
      expect(res.payload.error).toBe('Read-only member');
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
      expect(mockGoal.create).not.toHaveBeenCalled();
      expect(mockSegment.create).not.toHaveBeenCalled();
      // The gate fired in authorize(); no domain lookup happened.
      expect(mockDomain.findOne).not.toHaveBeenCalled();
      expect(mockDomain.findAll).not.toHaveBeenCalled();
   });
});
