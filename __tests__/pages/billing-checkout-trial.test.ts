import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Tests for POST /api/billing/checkout: the trial_end pass-through (Model A).
 *
 * Contract:
 *   - A FUTURE trial_ends_at -> subscription_data.trial_end is passed (unix seconds) so a mid-trial
 *     subscriber keeps their free days and is NOT charged immediately.
 *   - A PAST or NULL trial_ends_at -> trial_end is OMITTED (Stripe rejects a past trial_end; the
 *     subscription starts paid immediately).
 *   - The per-unit price x quantity line item is left intact in every case.
 *
 * No network: utils/stripe is mocked, the Account model is mocked, authorize() returns an account.
 */

jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));
jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('../../utils/ensureAdminAccount', () => ({ __esModule: true, default: jest.fn(async () => undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

const mockSessionsCreate = jest.fn();
const mockCustomersCreate = jest.fn();
jest.mock('../../utils/stripe', () => ({
   __esModule: true,
   isStripeConfigured: jest.fn(() => true),
   priceIdPerSite: jest.fn(() => 'price_per_site'),
   getStripe: jest.fn(() => ({
      customers: { create: mockCustomersCreate },
      checkout: { sessions: { create: mockSessionsCreate } },
   })),
}));

// eslint-disable-next-line import/first
import checkoutHandler from '../../pages/api/billing/checkout';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockAccount = AccountModel as unknown as { findOne: jest.Mock };
const ORIGINAL_ENV = { ...process.env };

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: Record<string, unknown> };
};

const makeReq = (sites: number): NextApiRequest => ({
   method: 'POST',
   headers: {},
   body: { sites },
} as unknown as NextApiRequest);

beforeEach(() => {
   jest.clearAllMocks();
   process.env = { ...ORIGINAL_ENV };
   process.env.MULTI_TENANT = 'true';
   process.env.STRIPE_SECRET_KEY = 'sk_test_x';
   process.env.NEXT_PUBLIC_APP_URL = 'https://app.s33k.io';
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 42 }, error: undefined });
   mockSessionsCreate.mockResolvedValue({ url: 'https://checkout.stripe.com/x' });
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/billing/checkout: trial_end pass-through', () => {
   it('passes trial_end (unix seconds) when trial_ends_at is in the FUTURE', async () => {
      const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const row = { ID: 42, name: 'Acme', stripe_customer_id: 'cus_42', trial_ends_at: future, save: jest.fn(async () => undefined) };
      mockAccount.findOne.mockResolvedValue(row);
      const res = makeRes();

      await checkoutHandler(makeReq(2), res);

      expect(res.statusCode).toBe(200);
      const arg = mockSessionsCreate.mock.calls[0][0] as Record<string, any>;
      expect(arg.subscription_data.trial_end).toBe(Math.floor(future.getTime() / 1000));
      // Per-unit price x quantity left intact.
      expect(arg.line_items).toEqual([{ price: 'price_per_site', quantity: 2 }]);
   });

   it('OMITS trial_end when trial_ends_at is in the PAST', async () => {
      const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const row = { ID: 42, name: 'Acme', stripe_customer_id: 'cus_42', trial_ends_at: past, save: jest.fn(async () => undefined) };
      mockAccount.findOne.mockResolvedValue(row);
      const res = makeRes();

      await checkoutHandler(makeReq(1), res);

      expect(res.statusCode).toBe(200);
      const arg = mockSessionsCreate.mock.calls[0][0] as Record<string, any>;
      expect(arg.subscription_data.trial_end).toBeUndefined();
      expect(arg.line_items).toEqual([{ price: 'price_per_site', quantity: 1 }]);
   });

   it('OMITS trial_end when trial_ends_at is NULL', async () => {
      const row = { ID: 42, name: 'Acme', stripe_customer_id: 'cus_42', trial_ends_at: null, save: jest.fn(async () => undefined) };
      mockAccount.findOne.mockResolvedValue(row);
      const res = makeRes();

      await checkoutHandler(makeReq(3), res);

      expect(res.statusCode).toBe(200);
      const arg = mockSessionsCreate.mock.calls[0][0] as Record<string, any>;
      expect(arg.subscription_data.trial_end).toBeUndefined();
      expect(arg.subscription_data.metadata.s33k_account_id).toBe('42');
   });
});
