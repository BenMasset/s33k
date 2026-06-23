/**
 * Route tests for GET /api/subscribe (the public, token-authed one-click pay link).
 *
 * Asserts: a valid token + a subscribable account redirects (302) to the Stripe URL; an already-active
 * account is sent to /welcome WITHOUT a redundant checkout; an invalid/expired token soft-lands on
 * /welcome (mutating nothing); an unknown account or a billing error soft-lands too; and a non-GET is
 * rejected. The Stripe boundary (createCheckoutSession) and the DB are mocked; the real signed-token
 * helper mints the tokens so the verify path is genuinely exercised.
 */

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../utils/billing-checkout', () => ({ __esModule: true, createCheckoutSession: jest.fn() }));
jest.mock('../../utils/baseUrl', () => ({ __esModule: true, resolveBaseUrl: jest.fn(() => 'https://app.s33k.io') }));
jest.mock('../../utils/collect-guards', () => ({ __esModule: true, clientIp: jest.fn(() => '127.0.0.1') }));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import subscribeHandler from '../../pages/api/subscribe';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';
// eslint-disable-next-line import/first
import { createCheckoutSession } from '../../utils/billing-checkout';
// eslint-disable-next-line import/first
import { mintSubscribeToken } from '../../utils/subscribeLink';
// eslint-disable-next-line import/first
import { __resetGenericRateLimit } from '../../utils/rate-limit';

const mockAccount = AccountModel as unknown as { findOne: jest.Mock };
const mockCheckout = createCheckoutSession as unknown as jest.Mock;

const ORIGINAL_ENV = { ...process.env };
const SECRET = 'subscribe-route-secret-0123456789';
const tokenFor = (id: number) => mintSubscribeToken({ ID: id } as never);

const makeReq = (opts: { method?: string, token?: string } = {}): NextApiRequest => ({
   method: opts.method || 'GET',
   query: opts.token !== undefined ? { token: opts.token } : {},
   headers: {},
   socket: { remoteAddress: '127.0.0.1' },
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = { statusCode: 200 };
   res.redirect = jest.fn((code: number, url: string) => { res.redirectCode = code; res.redirectUrl = url; return res; });
   res.setHeader = jest.fn(() => res);
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
   return res as unknown as NextApiResponse & { redirectUrl?: string, redirectCode?: number };
};

beforeEach(() => {
   jest.clearAllMocks();
   __resetGenericRateLimit();
   process.env = { ...ORIGINAL_ENV };
   process.env.SECRET = SECRET;
   mockAccount.findOne.mockResolvedValue({ ID: 7, subscription_status: 'trialing' });
   mockCheckout.mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' });
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('GET /api/subscribe', () => {
   it('valid token + subscribable account -> 302 redirect to the Stripe checkout URL', async () => {
      const res = makeRes();
      await subscribeHandler(makeReq({ token: tokenFor(7) as string }), res);
      expect(res.redirectUrl).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
      expect(res.redirectCode).toBe(302);
      // It created checkout for the account named in the token (id 7), 1 site.
      expect(mockCheckout).toHaveBeenCalledTimes(1);
      expect(mockCheckout.mock.calls[0][1]).toBe(1);
   });

   it('an ALREADY-ACTIVE account is sent to /welcome, with NO redundant checkout', async () => {
      mockAccount.findOne.mockResolvedValue({ ID: 7, subscription_status: 'active' });
      const res = makeRes();
      await subscribeHandler(makeReq({ token: tokenFor(7) as string }), res);
      expect(res.redirectUrl).toBe('https://app.s33k.io/welcome?billing=active');
      expect(mockCheckout).not.toHaveBeenCalled();
   });

   it('an invalid/expired token soft-lands on /welcome and mutates nothing', async () => {
      const res = makeRes();
      await subscribeHandler(makeReq({ token: 'not-a-valid-token' }), res);
      expect(res.redirectUrl).toBe('https://app.s33k.io/welcome?billing=expired');
      expect(mockAccount.findOne).not.toHaveBeenCalled();
      expect(mockCheckout).not.toHaveBeenCalled();
   });

   it('a missing token soft-lands on /welcome', async () => {
      const res = makeRes();
      await subscribeHandler(makeReq({}), res);
      expect(res.redirectUrl).toBe('https://app.s33k.io/welcome?billing=expired');
   });

   it('an unknown account (token valid, row gone) soft-lands on /welcome error', async () => {
      mockAccount.findOne.mockResolvedValue(null);
      const res = makeRes();
      await subscribeHandler(makeReq({ token: tokenFor(999) as string }), res);
      expect(res.redirectUrl).toBe('https://app.s33k.io/welcome?billing=error');
   });

   it('a billing/Stripe error soft-lands on /welcome error (no raw error page)', async () => {
      mockCheckout.mockResolvedValue({ error: 'Billing is not configured.', status: 503 });
      const res = makeRes();
      await subscribeHandler(makeReq({ token: tokenFor(7) as string }), res);
      expect(res.redirectUrl).toBe('https://app.s33k.io/welcome?billing=error');
   });

   it('rejects a non-GET method with a redirect, not a checkout', async () => {
      const res = makeRes();
      await subscribeHandler(makeReq({ method: 'POST', token: tokenFor(7) as string }), res);
      expect(res.redirectUrl).toBe('https://app.s33k.io/welcome?billing=error');
      expect(mockCheckout).not.toHaveBeenCalled();
   });
});
