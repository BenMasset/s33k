import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Trial-on-signup test for POST /api/invite/accept (MULTI_TENANT = 'true').
 *
 * acceptExternal is the ONLY path that creates a NEW account, so it is the only place a 14-day
 * NO-credit-card trial starts. It must create the account with subscription_status 'trialing',
 * trial_ends_at ~ now + 14 days, NO Stripe customer (no card at trial start), and NO paid_sites
 * (a trialing account is implicitly 1 site / 50 keywords via resolveCaps). Internal/share invites
 * mint keys on an EXISTING account and must NOT start a trial.
 *
 * No network, no DB: models are jest mocks, send-invite is stubbed.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));
jest.mock('../../database/models/account', () => ({
   __esModule: true,
   default: {
      create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), findOrCreate: jest.fn(),
   },
}));
jest.mock('../../database/models/apiKey', () => ({ __esModule: true, default: { create: jest.fn(), findOne: jest.fn() } }));
jest.mock('../../database/models/invite', () => ({
   __esModule: true,
   default: {
      create: jest.fn(), findAll: jest.fn(), findOne: jest.fn(), count: jest.fn(), update: jest.fn(),
   },
}));
jest.mock('../../utils/send-invite', () => ({ __esModule: true, sendInviteEmail: jest.fn(async () => ({ sent: false })), default: jest.fn(async () => ({ sent: false })) }));

// eslint-disable-next-line import/first
import acceptHandler from '../../pages/api/invite/accept';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import ApiKeyModel from '../../database/models/apiKey';
// eslint-disable-next-line import/first
import InviteModel from '../../database/models/invite';

const mockAccount = AccountModel as unknown as { create: jest.Mock, findOne: jest.Mock, findOrCreate: jest.Mock };
const mockApiKey = ApiKeyModel as unknown as { create: jest.Mock };
const mockInvite = InviteModel as unknown as { findOne: jest.Mock, update: jest.Mock };

const ORIGINAL_ENV = { ...process.env };
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const makeReq = (body: unknown): NextApiRequest => ({
   method: 'POST', body, query: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   res.getHeader = jest.fn(() => undefined);
   res.setHeader = jest.fn(() => undefined);
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   mockAccount.findOrCreate.mockResolvedValue([{ ID: 1 }, false]);
   mockInvite.update.mockResolvedValue([1]); // claim wins
   mockApiKey.create.mockResolvedValue({ ID: 500 });
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/invite/accept: external invite starts a 14-day no-CC trial', () => {
   it('creates the new account with trialing status, ~14-day trial_ends_at, and no Stripe customer', async () => {
      mockInvite.findOne.mockResolvedValue({
         ID: 40, code: 'GOODEXT', type: 'external', status: 'pending', email: 'founder@newco.com', target_account_id: null,
         get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
      });
      mockAccount.create.mockResolvedValue({ ID: 99, name: 'New Co', plan: 'free', status: 'active' });
      const before = Date.now();
      const res = makeRes();

      await acceptHandler(makeReq({ code: 'GOODEXT', name: 'New Co' }), res);

      expect(res.statusCode).toBe(201);
      expect(mockAccount.create).toHaveBeenCalledTimes(1);
      const createArg = mockAccount.create.mock.calls[0][0];
      expect(createArg.subscription_status).toBe('trialing');
      expect(createArg.stripe_customer_id).toBeNull();
      // A trialing account does not buy sites; paid_sites is left unset (resolveCaps gives it 1 site).
      expect(createArg.paid_sites === undefined || createArg.paid_sites === null).toBe(true);
      const endsAt = new Date(createArg.trial_ends_at).getTime();
      // ~14 days out from "now" (allow a small window for execution time).
      expect(endsAt).toBeGreaterThanOrEqual(before + FOURTEEN_DAYS_MS - 5000);
      expect(endsAt).toBeLessThanOrEqual(Date.now() + FOURTEEN_DAYS_MS + 5000);
   });
});

describe('POST /api/invite/accept: internal invite does NOT start a trial', () => {
   it('mints a member key on the existing account and never sets trial fields', async () => {
      mockInvite.findOne.mockResolvedValue({
         ID: 41, code: 'GOODINT', type: 'internal', status: 'pending', email: null, target_account_id: 2,
         get: (k: string) => (k === 'createdAt' ? new Date() : undefined),
      });
      mockAccount.findOne.mockResolvedValue({ ID: 2, name: 'Tenant A', status: 'active' });
      const res = makeRes();

      await acceptHandler(makeReq({ code: 'GOODINT' }), res);

      expect(res.statusCode).toBe(201);
      // No NEW account is created for an internal seat, so no trial is started anywhere.
      expect(mockAccount.create).not.toHaveBeenCalled();
   });
});
