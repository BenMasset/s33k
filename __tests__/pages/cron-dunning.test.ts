import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Dunning-sweep tests for POST /api/cron?mode=dunning (MULTI_TENANT = 'true').
 *
 * The dunning sweep mails the "your trial ends soon" notice to trialing accounts whose trial_ends_at
 * is within the dunning window. Like the scrape, it returns started:true immediately and pages the
 * accounts in the background (a fire-and-forget drain), so we flush macrotask ticks before asserting.
 *
 * Properties proven here:
 *   1. With MULTI_TENANT on + admin caller, near-expiry trialing accounts are found and each is passed
 *      to sendTrialEnding (paged via CRON_PAGE_SIZE).
 *   2. With MULTI_TENANT off, it is a pure no-op: started:true, no account query, no email.
 *
 * No network, no DB: models + sendTrialEnding + settings + authorize are mocked.
 */

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('sequelize', () => ({
   __esModule: true,
   Op: { in: Symbol('in'), notIn: Symbol('notIn'), gt: Symbol('gt'), lte: Symbol('lte') },
}));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { update: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/auditLog', () => ({ __esModule: true, recordAudit: jest.fn(async () => undefined), default: jest.fn(async () => undefined) }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => []) }));
jest.mock('../../utils/scraper', () => ({ __esModule: true, failedRetryWhere: jest.fn(() => ({})) }));
jest.mock('../../utils/sendTrialEnding', () => ({
   __esModule: true,
   sendTrialEnding: jest.fn(async () => undefined),
   default: jest.fn(async () => undefined),
}));

// eslint-disable-next-line import/first
import cronHandler from '../../pages/api/cron';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { sendTrialEnding } from '../../utils/sendTrialEnding';
// eslint-disable-next-line import/first
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

const mockAccount = AccountModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockSend = sendTrialEnding as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const soon = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);

const makeReq = (): NextApiRequest => ({
   method: 'POST', body: {}, query: { mode: 'dunning' }, headers: { authorization: 'Bearer admin' }, socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

// The sweep returns started:true immediately, then pages accounts in the background (awaiting the
// mocked findAll + send). Flush macrotask ticks to let the background drain run to completion.
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
   mockAuthorize.mockResolvedValue({ authorized: true, account: { ID: ADMIN_ACCOUNT_ID }, role: 'admin' });
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/cron?mode=dunning', () => {
   it('finds near-expiry trialing accounts and calls sendTrialEnding for each', async () => {
      // Two unique account IDs so the per-account once-per-day dedup does not suppress either, and a
      // distinct day bucket per run is not needed because clearAllMocks does not reset the module map.
      // First page returns the accounts, the next page (cursor advanced) is empty so the drain ends.
      mockAccount.findAll
         .mockResolvedValueOnce([
            { ID: 101, email: 'c1', trial_ends_at: soon },
            { ID: 102, email: 'c2', trial_ends_at: soon },
         ])
         .mockResolvedValue([]);
      const res = makeRes();

      await cronHandler(makeReq(), res);
      expect(res.statusCode).toBe(200);
      expect((res as unknown as { payload: { started: boolean } }).payload.started).toBe(true);

      await flushDrain();

      expect(mockSend).toHaveBeenCalledTimes(2);
      const ids = mockSend.mock.calls.map((c) => (c[0] as { ID: number }).ID).sort();
      expect(ids).toEqual([101, 102]);
   });

   it('with MULTI_TENANT off, is a pure no-op (no account query, no email)', async () => {
      delete process.env.MULTI_TENANT;
      const res = makeRes();

      await cronHandler(makeReq(), res);
      await flushDrain();

      expect(res.statusCode).toBe(200);
      expect((res as unknown as { payload: { started: boolean } }).payload.started).toBe(true);
      expect(mockAccount.findAll).not.toHaveBeenCalled();
      expect(mockSend).not.toHaveBeenCalled();
   });
});
