import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Spend-brake tests for POST /api/cron (MULTI_TENANT = 'true').
 *
 * When the operator runs cron account-wide (admin caller, scope {}), keywords owned by an INACTIVE
 * account (expired trial / canceled) must NOT be scraped: each scrape is a paid SERP call. The route
 * resolves each keyword's owner and drops those whose owner is inactive before calling refresh.
 *
 * With MULTI_TENANT off the single admin account is always active, so the filter is a no-op and the
 * single-tenant path is unchanged (covered by the last case).
 *
 * No network, no DB: models + refresh + settings + authorize are mocked.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), notIn: Symbol('notIn') } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { update: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
// recordAudit imports the AuditLog sequelize model; mock it to a no-op so the cron test stays pure
// (the privileged-access audit write is itself best-effort/non-blocking). Cron scoping is asserted below.
jest.mock('../../utils/auditLog', () => ({ __esModule: true, recordAudit: jest.fn(async () => undefined), default: jest.fn(async () => undefined) }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => []) }));
// utils/scraper imports cheerio (ESM jest cannot parse); mock the only symbol cron.ts pulls from it.
jest.mock('../../utils/scraper', () => ({ __esModule: true, failedRetryWhere: jest.fn(() => ({})) }));

// eslint-disable-next-line import/first
import cronHandler from '../../pages/api/cron';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import refreshFn from '../../utils/refresh';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

const mockKeyword = KeywordModel as unknown as { update: jest.Mock, findAll: jest.Mock };
const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockAccount = AccountModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockRefresh = refreshFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

// A keyword mock whose .get('owner_id') returns the given owner.
const kw = (id: number, ownerId: number | null) => ({
   ID: id,
   get: (k: string) => (k === 'owner_id' ? ownerId : ({ ID: id, owner_id: ownerId })),
});

const makeReq = (): NextApiRequest => ({
   method: 'POST', body: {}, query: {}, headers: { authorization: 'Bearer admin' }, socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

// The cron scrape now runs as a fire-and-forget background DRAIN (the handler returns started:true
// immediately, then a paged loop scrapes the full set so a 1000-site instance is not starved past the
// first page). The drain awaits mocked DB ops, so flush several macrotask ticks after the handler
// returns to let it run to completion before asserting. The page mock below returns the rows ONCE then
// [] (modelling the DB honoring Op.notIn / the cursor draining), so the drain terminates in one page.
const flushDrain = async (ticks = 25) => {
   for (let i = 0; i < ticks; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setTimeout(resolve, 0); });
   }
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // Admin caller -> scopeWhere returns {} (account-wide), the spend brake applies.
   mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
   mockKeyword.update.mockResolvedValue([0]);
   mockDomain.findAll.mockResolvedValue([]);
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/cron: spend brake skips inactive-account keywords', () => {
   it('drops keywords owned by an inactive account and keeps active + admin (null-owner) ones', async () => {
      // owner 2 active (trialing, future), owner 3 inactive (canceled), keyword 30 has null owner (admin/legacy).
      // First drain page returns the rows; the next page is empty (cursor drained), so the drain ends.
      mockKeyword.findAll.mockResolvedValueOnce([kw(10, 2), kw(20, 3), kw(30, null)]).mockResolvedValue([]);
      mockAccount.findAll.mockResolvedValue([
         { ID: 2, subscription_status: 'trialing', trial_ends_at: future },
         { ID: 3, subscription_status: 'canceled', trial_ends_at: null },
      ]);
      const res = makeRes();

      await cronHandler(makeReq(), res);
      await flushDrain();

      expect(res.statusCode).toBe(200);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      const scraped = mockRefresh.mock.calls[0][0] as Array<{ ID: number }>;
      const ids = scraped.map((k) => k.ID).sort();
      // keyword 20 (owner 3, canceled) is dropped; 10 (active) and 30 (admin/null) remain.
      expect(ids).toEqual([10, 30]);
   });

   it('with MULTI_TENANT off, scrapes every keyword (no brake, single-tenant unchanged)', async () => {
      delete process.env.MULTI_TENANT;
      mockKeyword.findAll.mockResolvedValueOnce([kw(10, 2), kw(20, 3), kw(30, null)]).mockResolvedValue([]);
      const res = makeRes();

      await cronHandler(makeReq(), res);
      await flushDrain();

      expect(res.statusCode).toBe(200);
      const scraped = mockRefresh.mock.calls[0][0] as Array<{ ID: number }>;
      expect(scraped.map((k) => k.ID).sort()).toEqual([10, 20, 30]);
      // The brake never queries accounts when the flag is off.
      expect(mockAccount.findAll).not.toHaveBeenCalled();
   });
});
