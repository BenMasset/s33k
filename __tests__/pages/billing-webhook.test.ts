import type { NextApiRequest, NextApiResponse } from 'next';
import { EventEmitter } from 'events';

/**
 * Tests for POST /api/billing/webhook: the PUBLIC, Stripe-signature-verified webhook.
 *
 * Contracts (per-unit model):
 *   1. A BAD/MISSING signature -> 400, and NOTHING is mutated (no account.update).
 *   2. A valid checkout.session.completed event -> stamps stripe_customer_id, paid_sites (the
 *      subscription's QUANTITY = number of sites), and subscription_status on the matching account.
 *
 * No network: utils/stripe is mocked so constructEvent is controllable and subscriptions.retrieve is
 * stubbed. The Account model is mocked. The raw request body is delivered via a stream emitter.
 */

jest.mock('../../database/database', () => ({
   __esModule: true,
   default: { sync: jest.fn(async () => undefined) },
   ensureSynced: jest.fn(async () => undefined),
}));
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in') } }));
jest.mock('../../database/models/account', () => ({ __esModule: true, default: { findOne: jest.fn() } }));

const mockConstructEvent = jest.fn();
const mockRetrieve = jest.fn();
jest.mock('../../utils/stripe', () => ({
   __esModule: true,
   isStripeConfigured: jest.fn(() => true),
   getStripe: jest.fn(() => ({
      webhooks: { constructEvent: mockConstructEvent },
      subscriptions: { retrieve: mockRetrieve },
   })),
   // Per-unit: a single price, no price->tier reverse map. priceIdPerSite is the only accessor.
   priceIdPerSite: jest.fn(() => 'price_per_site'),
}));

const mockSendPaymentFailed = jest.fn(async () => undefined);
jest.mock('../../utils/sendPaymentFailed', () => ({
   __esModule: true,
   sendPaymentFailed: (...args: unknown[]) => mockSendPaymentFailed(...args),
}));

// eslint-disable-next-line import/first
import webhookHandler from '../../pages/api/billing/webhook';
// eslint-disable-next-line import/first
import AccountModel from '../../database/models/account';

const mockAccount = AccountModel as unknown as { findOne: jest.Mock };
const ORIGINAL_ENV = { ...process.env };

// A NextApiRequest whose body is delivered as a stream (bodyParser is disabled on this route).
const makeReq = (opts: { signature?: string | undefined, body?: string }): NextApiRequest => {
   const emitter = new EventEmitter() as unknown as NextApiRequest;
   (emitter as unknown as { method: string }).method = 'POST';
   (emitter as unknown as { headers: Record<string, unknown> }).headers = opts.signature === undefined
      ? {}
      : { 'stripe-signature': opts.signature };
   // Emit the raw body on the next microtask, after the handler has attached its data/end
   // listeners (jsdom has no setImmediate; a resolved-promise tick is enough and deterministic).
   Promise.resolve().then(() => {
      if (opts.body) { emitter.emit('data', Buffer.from(opts.body)); }
      emitter.emit('end');
   });
   return emitter;
};

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
   process.env.STRIPE_SECRET_KEY = 'sk_test_x';
   process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
});
afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

describe('POST /api/billing/webhook: signature gate', () => {
   it('400s a MISSING signature and mutates nothing', async () => {
      const res = makeRes();
      await webhookHandler(makeReq({ signature: undefined, body: '{}' }), res);
      expect(res.statusCode).toBe(400);
      expect(mockConstructEvent).not.toHaveBeenCalled();
      expect(mockAccount.findOne).not.toHaveBeenCalled();
   });

   it('400s a BAD signature (constructEvent throws) and mutates nothing', async () => {
      mockConstructEvent.mockImplementation(() => { throw new Error('signature verification failed'); });
      const res = makeRes();
      await webhookHandler(makeReq({ signature: 'bad', body: '{"x":1}' }), res);
      expect(res.statusCode).toBe(400);
      expect(res.payload.error).toMatch(/invalid signature/i);
      expect(mockAccount.findOne).not.toHaveBeenCalled();
   });
});

describe('POST /api/billing/webhook: valid checkout.session.completed', () => {
   it('stamps customer id, paid_sites (the subscription quantity), and active status', async () => {
      // The webhook writes via account.update(partial) (the mutate-via-update convention).
      const update = jest.fn(async () => undefined);
      const account = { ID: 7, stripe_customer_id: null, subscription_status: 'trialing', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'checkout.session.completed',
         data: { object: { customer: 'cus_123', subscription: 'sub_123', client_reference_id: '7', metadata: {} } },
      });
      // The subscription's first line item carries quantity = 3 sites; that is what paid_sites becomes.
      mockRetrieve.mockResolvedValue({
         status: 'active',
         current_period_end: 1_800_000_000,
         items: { data: [{ quantity: 3, price: { id: 'price_per_site' } }] },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_1"}' }), res);

      expect(res.statusCode).toBe(200);
      expect(update).toHaveBeenCalledTimes(1);
      const applied = update.mock.calls[0][0] as Record<string, unknown>;
      expect(applied.stripe_customer_id).toBe('cus_123');
      expect(applied.paid_sites).toBe(3);
      expect(applied.subscription_status).toBe('active');
   });
});

describe('POST /api/billing/webhook: lifecycle coverage', () => {
   it('customer.subscription.deleted -> sets canceled', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 9, stripe_customer_id: 'cus_9', subscription_status: 'active', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'customer.subscription.deleted',
         data: { object: { customer: 'cus_9', metadata: { s33k_account_id: '9' } } },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_del"}' }), res);

      expect(res.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith({ subscription_status: 'canceled' });
   });

   it('invoice.payment_failed -> sets past_due AND fires sendPaymentFailed', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 11, stripe_customer_id: 'cus_11', subscription_status: 'active', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'invoice.payment_failed',
         data: { object: { customer: 'cus_11' } },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_fail"}' }), res);

      expect(res.statusCode).toBe(200);
      expect(update).toHaveBeenCalledWith({ subscription_status: 'past_due' });
      expect(mockSendPaymentFailed).toHaveBeenCalledTimes(1);
      expect(mockSendPaymentFailed).toHaveBeenCalledWith(account);
   });

   it('invoice.payment_succeeded after past_due -> re-fetches subscription and re-applies active', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 12, stripe_customer_id: 'cus_12', subscription_status: 'past_due', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'invoice.payment_succeeded',
         data: { object: { customer: 'cus_12', subscription: 'sub_12' } },
      });
      mockRetrieve.mockResolvedValue({
         status: 'active',
         current_period_end: 1_900_000_000,
         items: { data: [{ quantity: 2, price: { id: 'price_per_site' } }] },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_ok"}' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockRetrieve).toHaveBeenCalledWith('sub_12');
      const applied = update.mock.calls[0][0] as Record<string, unknown>;
      expect(applied.subscription_status).toBe('active');
      expect(applied.paid_sites).toBe(2);
   });

   it('invoice.payment_succeeded when ALREADY active -> no-op (no re-fetch, no update)', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 13, stripe_customer_id: 'cus_13', subscription_status: 'active', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'invoice.payment_succeeded',
         data: { object: { customer: 'cus_13', subscription: 'sub_13' } },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_noop"}' }), res);

      expect(res.statusCode).toBe(200);
      expect(mockRetrieve).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
   });

   it('customer.subscription.updated quantity change -> paid_sites updated', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 14, stripe_customer_id: 'cus_14', subscription_status: 'active', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'customer.subscription.updated',
         data: {
            object: {
               customer: 'cus_14',
               status: 'active',
               current_period_end: 1_950_000_000,
               metadata: { s33k_account_id: '14' },
               items: { data: [{ quantity: 5, price: { id: 'price_per_site' } }] },
            },
         },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_upd"}' }), res);

      expect(res.statusCode).toBe(200);
      const applied = update.mock.calls[0][0] as Record<string, unknown>;
      expect(applied.paid_sites).toBe(5);
      expect(applied.subscription_status).toBe('active');
   });

   it('customer.subscription.trial_will_end -> 200, no mutation (email is cron-driven)', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 15, stripe_customer_id: 'cus_15', subscription_status: 'trialing', update };
      mockAccount.findOne.mockResolvedValue(account);
      mockConstructEvent.mockReturnValue({
         type: 'customer.subscription.trial_will_end',
         data: { object: { customer: 'cus_15', metadata: { s33k_account_id: '15' } } },
      });
      const res = makeRes();

      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_twe"}' }), res);

      expect(res.statusCode).toBe(200);
      expect(update).not.toHaveBeenCalled();
      expect(mockSendPaymentFailed).not.toHaveBeenCalled();
   });

   it('idempotent replay of customer.subscription.updated -> same state', async () => {
      const update = jest.fn(async () => undefined);
      const account = { ID: 16, stripe_customer_id: 'cus_16', subscription_status: 'active', update };
      mockAccount.findOne.mockResolvedValue(account);
      const evt = {
         type: 'customer.subscription.updated',
         data: {
            object: {
               customer: 'cus_16',
               status: 'active',
               current_period_end: 1_960_000_000,
               metadata: { s33k_account_id: '16' },
               items: { data: [{ quantity: 4, price: { id: 'price_per_site' } }] },
            },
         },
      };
      mockConstructEvent.mockReturnValue(evt);

      const res1 = makeRes();
      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_rep"}' }), res1);
      const res2 = makeRes();
      await webhookHandler(makeReq({ signature: 'good', body: '{"id":"evt_rep"}' }), res2);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);
      const first = update.mock.calls[0][0] as Record<string, unknown>;
      const second = update.mock.calls[1][0] as Record<string, unknown>;
      expect(second).toEqual(first);
      expect(first.paid_sites).toBe(4);
   });
});
