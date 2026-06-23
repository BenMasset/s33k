/**
 * Billing-locked-state visibility: the additive billing banner on start_here and the additive
 * billing annotation on dashboard.
 *
 * The brief: a near-expiry or expired/locked account must SEE its billing state from inside the
 * user's AI client, with the exact in-LLM fix path (call billing_status then start_checkout). The
 * banner is ADDITIVE: it is absent on a healthy active account, and never emitted in single-tenant
 * (MULTI_TENANT off -> isAccountActive is always true). Reads are NEVER gated by it.
 *
 * These tests run with MULTI_TENANT='true' and a real (non-admin) tenant account, so isAccountActive
 * actually evaluates subscription_status / trial_ends_at. The DB models, authorize, and analytics
 * provider are mocked per the repo route-test convention (see start-here.test.ts / dashboard.test.ts).
 */
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn(async () => undefined) }, ensureSynced: jest.fn(async () => undefined) }));
jest.mock('sequelize', () => ({
   __esModule: true,
   Op: { gte: Symbol('gte'), lt: Symbol('lt'), in: Symbol('in') },
}));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn(), findAll: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn(), count: jest.fn() } }));
jest.mock('../../database/models/s33kEvent', () => ({ __esModule: true, default: { findAll: jest.fn(), count: jest.fn() } }));
jest.mock('../../database/models/goal', () => ({ __esModule: true, default: { findAll: jest.fn(), count: jest.fn() } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../utils/analytics', () => ({
   __esModule: true,
   getAnalyticsProvider: jest.fn(),
}));

// eslint-disable-next-line import/first
import type { NextApiRequest, NextApiResponse } from 'next';
// eslint-disable-next-line import/first
import startHereHandler from '../../pages/api/start-here';
// eslint-disable-next-line import/first
import dashboardHandler from '../../pages/api/dashboard';
// eslint-disable-next-line import/first
import DomainModel from '../../database/models/domain';
// eslint-disable-next-line import/first
import KeywordModel from '../../database/models/keyword';
// eslint-disable-next-line import/first
import S33kEventModel from '../../database/models/s33kEvent';
// eslint-disable-next-line import/first
import GoalModel from '../../database/models/goal';
// eslint-disable-next-line import/first
import authorizeFn from '../../utils/authorize';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';

const mockDomain = DomainModel as unknown as { findOne: jest.Mock, findAll: jest.Mock };
const mockKeyword = KeywordModel as unknown as { findAll: jest.Mock, count: jest.Mock };
const mockEvent = S33kEventModel as unknown as { findAll: jest.Mock, count: jest.Mock };
const mockGoal = GoalModel as unknown as { findAll: jest.Mock, count: jest.Mock };
const mockAuthorize = authorizeFn as unknown as jest.Mock;
const mockProvider = getAnalyticsProvider as unknown as jest.Mock;

const row = (data: Record<string, unknown>) => ({ get: () => data, ...data });

const makeReq = (query: Record<string, string>, method = 'GET'): NextApiRequest => ({
   method, query, body: {}, headers: {},
} as unknown as NextApiRequest);

const makeRes = () => {
   const res: Record<string, unknown> = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
   res.json = jest.fn((payload: unknown) => { res.payload = payload; return res; });
   return res as unknown as NextApiResponse & { statusCode: number, payload: any };
};

const providerStub = () => ({
   getPageTraffic: jest.fn(async () => ({ pages: [], error: null })),
   getReferralSources: jest.fn(async () => ({ sources: [], error: null })),
   getSummary: jest.fn(async () => ({ pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null })),
});

// A real (non-admin) tenant account in the four billing states. ID is NOT ADMIN_ACCOUNT_ID (1), so
// isAccountActive evaluates the subscription columns rather than the always-active admin sentinel.
const TENANT_ID = 42;
const inDays = (n: number) => new Date(Date.now() + n * 86400e3);
const account = (over: Record<string, unknown>) => ({
   ID: TENANT_ID, domain: 'getmasset.com', subscription_status: null, trial_ends_at: null, paid_sites: null, ...over,
});

let prevFlag: string | undefined;
beforeAll(() => { prevFlag = process.env.MULTI_TENANT; process.env.MULTI_TENANT = 'true'; });
afterAll(() => { if (prevFlag === undefined) { delete process.env.MULTI_TENANT; } else { process.env.MULTI_TENANT = prevFlag; } });

beforeEach(() => {
   jest.clearAllMocks();
   // Owned domain, single tracked domain so start_here uses it without a ?domain=.
   mockDomain.findOne.mockResolvedValue(row({ ID: TENANT_ID, domain: 'getmasset.com' }));
   mockDomain.findAll.mockResolvedValue([row({ domain: 'getmasset.com' })]);
   mockKeyword.count.mockResolvedValue(0);
   mockEvent.count.mockResolvedValue(0);
   mockGoal.count.mockResolvedValue(0);
   mockKeyword.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
   mockGoal.findAll.mockResolvedValue([]);
   mockProvider.mockReturnValue(providerStub());
});

describe('start_here billing banner', () => {
   it('surfaces a "trial ends in N days" banner for a trial ending soon, with a one-click subscribe link', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'trialing', trial_ends_at: inDays(2) }), error: undefined });
      const res = makeRes();
      await startHereHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.billing).toBeDefined();
      expect(res.payload.billing.state).toBe('trial-ending');
      expect(res.payload.billing.headline).toMatch(/Your free trial ends in \d+ days?/);
      // nextStep is now a one-click pre-authenticated pay link (not "call start_checkout" jargon).
      expect(res.payload.billing.nextStep).toContain('one click');
      expect(res.payload.billing.nextStep).toContain('/api/subscribe?token=');
   });

   it('surfaces a "trial has ended, subscribe" banner for a locked (expired-trial) account', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'trialing', trial_ends_at: inDays(-1) }), error: undefined });
      const res = makeRes();
      await startHereHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.billing).toBeDefined();
      expect(res.payload.billing.state).toBe('locked');
      expect(res.payload.billing.headline).toMatch(/your free trial has ended/i);
      expect(res.payload.billing.nextStep).toContain('/api/subscribe?token=');
   });

   it('surfaces a locked banner for a canceled subscription', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'canceled' }), error: undefined });
      const res = makeRes();
      await startHereHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.billing.state).toBe('locked');
   });

   it('stays SILENT (no billing field) for a healthy active account', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'active', paid_sites: 2 }), error: undefined });
      const res = makeRes();
      await startHereHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.billing).toBeUndefined();
   });

   it('stays SILENT for a trial with plenty of runway left (not ending soon)', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'trialing', trial_ends_at: inDays(10) }), error: undefined });
      const res = makeRes();
      await startHereHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.billing).toBeUndefined();
   });
});

describe('dashboard billing annotation', () => {
   it('annotates locked:true with action start_checkout for a locked account, and still returns the full overview', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'past_due' }), error: undefined });
      const res = makeRes();
      await dashboardHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      // Reads are NOT capped: the dashboard overview is still present.
      expect(res.payload.dashboard).toBeDefined();
      // The non-blocking lock annotation is present.
      expect(res.payload.billing).toBeDefined();
      expect(res.payload.billing.locked).toBe(true);
      expect(res.payload.billing.action).toBe('start_checkout');
      // Human-first message + a one-click pre-authenticated pay link.
      expect(res.payload.billing.message).toMatch(/your 14-day free trial has ended/i);
      expect(res.payload.billing.message).toContain('/api/subscribe?token=');
   });

   it('stays SILENT (no billing field) for a healthy active account', async () => {
      mockAuthorize.mockResolvedValue({ authorized: true, account: account({ subscription_status: 'active', paid_sites: 1 }), error: undefined });
      const res = makeRes();
      await dashboardHandler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.dashboard).toBeDefined();
      expect(res.payload.billing).toBeUndefined();
   });
});
