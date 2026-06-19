import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Tests for the DB-backed hourly retry job: POST /api/cron?mode=retry.
 *
 * This replaces the old failed_queue.json + /api/refresh?id=... path. The route finds keywords that
 * currently have a real lastUpdateError (failedRetryWhere) and re-scrapes ONLY those, reusing the same
 * Bearer auth and the same spend-brake as the full scrape. With MULTI_TENANT on and an account-wide
 * run, keywords owned by an INACTIVE account must NOT be retry-scraped (each scrape is a paid call).
 *
 * No network, no DB: models + refresh + settings + scraper helper + authorize are mocked.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { update: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => []) }));
// scraper imports cheerio; the route only needs failedRetryWhere from it (stubbed to a sentinel where).
const RETRY_WHERE = { __retry: true };
jest.mock('../../utils/scraper', () => ({ __esModule: true, failedRetryWhere: jest.fn(() => RETRY_WHERE) }));

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
const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

// A keyword mock whose .get('owner_id') / .get('ID') answer for the spend-brake and id mark.
const kw = (id: number, ownerId: number | null) => ({
   ID: id,
   get: (k: string) => {
      if (k === 'owner_id') { return ownerId; }
      if (k === 'ID') { return id; }
      return ({ ID: id, owner_id: ownerId });
   },
});

const makeReq = (query: Record<string, unknown> = {}): NextApiRequest => ({
   method: 'POST', body: {}, query, headers: { authorization: 'Bearer admin' }, socket: { remoteAddress: '127.0.0.1' },
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
   mockKeyword.update.mockResolvedValue([0]);
   mockDomain.findAll.mockResolvedValue([]);
});

afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/cron?mode=retry', () => {
   it('refreshes exactly the keywords returned by the failed-retry query', async () => {
      delete process.env.MULTI_TENANT;
      mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
      const errored = [kw(11, null), kw(22, null)];
      mockKeyword.findAll.mockResolvedValue(errored);

      const res = makeRes();
      await cronHandler(makeReq({ mode: 'retry' }), res);

      expect(res.statusCode).toBe(200);
      // The findAll where included the failed-retry fragment (the retry set, not all keywords).
      expect(mockKeyword.findAll.mock.calls[0][0].where).toEqual(expect.objectContaining(RETRY_WHERE));
      // refresh was called with exactly the errored keywords.
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      expect(mockRefresh.mock.calls[0][0]).toEqual(errored);
   });

   it('does nothing (but 200) when no keyword needs a retry', async () => {
      delete process.env.MULTI_TENANT;
      mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
      mockKeyword.findAll.mockResolvedValue([]);

      const res = makeRes();
      await cronHandler(makeReq({ mode: 'retry' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockRefresh).not.toHaveBeenCalled();
   });

   it('with MULTI_TENANT on, does NOT retry-scrape keywords owned by an INACTIVE account', async () => {
      process.env.MULTI_TENANT = 'true';
      // Admin caller -> scopeWhere {} -> account-wide -> spend brake applies.
      mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
      // Keyword 11 -> active owner 2, keyword 22 -> inactive owner 3.
      mockKeyword.findAll.mockResolvedValue([kw(11, 2), kw(22, 3)]);
      mockAccount.findAll.mockResolvedValue([
         { ID: 2, subscription_status: 'active', trial_ends_at: null, current_period_end: future },
         { ID: 3, subscription_status: 'canceled', trial_ends_at: past, current_period_end: past },
      ]);

      const res = makeRes();
      await cronHandler(makeReq({ mode: 'retry' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      const refreshed = mockRefresh.mock.calls[0][0] as Array<{ ID: number }>;
      // Only keyword 11 (active owner) is retry-scraped; 22 (inactive owner) is dropped.
      expect(refreshed.map((k) => k.ID)).toEqual([11]);
   });
});
