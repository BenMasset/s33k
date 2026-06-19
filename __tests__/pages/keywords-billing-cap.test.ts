import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Billing-cap tests for POST /api/keywords (MULTI_TENANT = 'true').
 *
 * On top of the existing per-domain cap, the route enforces resolveCaps(account).keywords (the total
 * across the account in the per-unit model: 50 * sites). It counts the account's EXISTING tracked
 * keywords plus the number being added, and 403s when the total would exceed the cap. A trialing
 * account gets 1 site = 50 keywords; an active account gets 50 * paid_sites; an inactive (expired-
 * trial / canceled) account has a 0 cap and is locked out of adds with an upgrade message.
 *
 * No network, no DB: models are jest mocks, authorize injects the caller, and the scrape / volume /
 * search-console side effects are stubbed so the test only exercises the gating.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));

jest.mock('../../database/models/keyword', () => ({
   __esModule: true,
   default: {
      findAll: jest.fn(), count: jest.fn(), bulkCreate: jest.fn(), update: jest.fn(), destroy: jest.fn(), findOne: jest.fn(),
   },
}));
jest.mock('../../database/models/domain', () => ({
   __esModule: true,
   default: { findAll: jest.fn() },
}));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../pages/api/settings', () => ({ __esModule: true, getAppSettings: jest.fn(async () => ({ scraper_type: 'serper' })) }));
jest.mock('../../utils/refresh', () => ({ __esModule: true, default: jest.fn(async () => []) }));
jest.mock('../../utils/searchConsole', () => ({ __esModule: true, integrateKeywordSCData: jest.fn(), readLocalSCData: jest.fn(async () => false) }));
jest.mock('../../utils/adwords', () => ({ __esModule: true, getKeywordsVolume: jest.fn(async () => ({ volumes: false })), updateKeywordsVolumeData: jest.fn() }));
jest.mock('../../utils/scraper', () => ({ __esModule: true, removeFromRetryQueue: jest.fn(async () => undefined) }));

// eslint-disable-next-line import/first
import keywordsHandler from '../../pages/api/keywords';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';

const mockKeyword = KeywordModel as unknown as {
   findAll: jest.Mock, count: jest.Mock, bulkCreate: jest.Mock,
};
const mockDomain = DomainModel as unknown as { findAll: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

const asCaller = (account: unknown) => {
   mockAuthorize.mockResolvedValue({ authorized: true, account, role: 'admin' });
};

const makeReq = (body: unknown): NextApiRequest => ({
   method: 'POST', body, query: {}, headers: { authorization: 'Bearer s33k_x' }, socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

const oneKeyword = (domain = 'tenant-a.com') => ([{ keyword: 'seo tools', device: 'desktop', country: 'US', domain }]);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   // Caller owns the domain they add keywords for.
   mockDomain.findAll.mockResolvedValue([{ domain: 'tenant-a.com' }]);
   mockKeyword.bulkCreate.mockResolvedValue([{ get: () => ({ ID: 1, keyword: 'seo tools', history: '{}', tags: '[]' }) }]);
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/keywords: billing keyword cap', () => {
   it('SUCCEEDS when the account is UNDER its trial cap (1 site = 50 keywords)', async () => {
      asCaller({ ID: 2, subscription_status: 'trialing', trial_ends_at: future, paid_sites: null });
      // count() is called for the per-domain cap (existing per domain) AND the billing total.
      mockKeyword.count.mockResolvedValue(10); // well under the trial cap of 50
      const res = makeRes();
      await keywordsHandler(makeReq({ keywords: oneKeyword() }), res);
      expect(res.statusCode).toBe(201);
      expect(mockKeyword.bulkCreate).toHaveBeenCalledTimes(1);
   });

   it('403s when adding would EXCEED the trial cap (50) and never creates keywords', async () => {
      asCaller({ ID: 2, subscription_status: 'trialing', trial_ends_at: future, paid_sites: null });
      mockKeyword.count.mockResolvedValue(50); // already at the trial cap of 50 (1 site)
      const res = makeRes();
      await keywordsHandler(makeReq({ keywords: oneKeyword() }), res);
      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/limit reached for your plan/i);
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
   });

   it('403s an EXPIRED-trial (locked, 0 cap) account with an upgrade message', async () => {
      asCaller({ ID: 2, subscription_status: 'trialing', trial_ends_at: past, paid_sites: null });
      mockKeyword.count.mockResolvedValue(0);
      const res = makeRes();
      await keywordsHandler(makeReq({ keywords: oneKeyword() }), res);
      expect(res.statusCode).toBe(403);
      expect(res.payload.error).toMatch(/trial has ended|subscription is inactive/i);
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
   });

   it('lets an ACTIVE 2-site account add under its 100-keyword cap', async () => {
      asCaller({ ID: 2, subscription_status: 'active', paid_sites: 2 });
      mockKeyword.count.mockResolvedValue(99); // 99 + 1 = 100 == cap (50 * 2 sites), allowed
      const res = makeRes();
      await keywordsHandler(makeReq({ keywords: oneKeyword() }), res);
      expect(res.statusCode).toBe(201);
   });

   it('403s an ACTIVE 2-site account that would push past its 100-keyword cap', async () => {
      asCaller({ ID: 2, subscription_status: 'active', paid_sites: 2 });
      mockKeyword.count.mockResolvedValue(100); // 100 + 1 > 100, denied
      const res = makeRes();
      await keywordsHandler(makeReq({ keywords: oneKeyword() }), res);
      expect(res.statusCode).toBe(403);
      expect(mockKeyword.bulkCreate).not.toHaveBeenCalled();
   });
});
