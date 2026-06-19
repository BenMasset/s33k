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

jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
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
