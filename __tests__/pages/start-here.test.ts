/**
 * start-here route: the guided entry point ("I do not know what to ask").
 *
 * Covers the three modes the brief requires:
 *   - setup-incomplete: a tracked-but-half-set-up domain returns mode "setup" with the single next
 *     step + tool, and does NOT dump analytics.
 *   - ready: a fully set-up domain returns mode "ready" with a headline, a top action, the curated
 *     nextSteps (which MUST include entry_pages), and a rendered block.
 *   - pick-domain: no ?domain= with multiple tracked domains returns mode "pick-domain" with the list.
 * Plus the no-domain and not-owned (setup-style) graceful paths and the HTTP guards (401/405).
 *
 * The analytics provider is mocked at utils/analytics so no real Umami/Lodd call happens. The DB
 * models and authorize are mocked per the repo route-test convention (see dashboard.test.ts).
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
import handler from '../../pages/api/start-here';
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
const pv = (session: string, page: string, source: string, is_bot: boolean, created: string) =>
   row({ session, page, source, is_bot, created, type: 'pageview', device: 'desktop', country: 'US' });
const kw = (keyword: string, position: number, url: string, target_page: string, history: string) =>
   row({ keyword, position, url, target_page, history, tags: '[]', lastResult: '[]', lastUpdateError: 'false' });

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

const providerStub = (over: Partial<Record<string, unknown>> = {}) => ({
   getPageTraffic: jest.fn(async () => over.traffic || { pages: [], error: null }),
   getReferralSources: jest.fn(async () => over.referrals || { sources: [], error: null }),
   getSummary: jest.fn(async () => over.summary || ({
      pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null,
   })),
});

beforeEach(() => {
   jest.clearAllMocks();
   mockAuthorize.mockResolvedValue({ authorized: true, account: null, error: undefined });
   // Owned by default (resolveDomainAccess does Domain.findOne under the hood).
   mockDomain.findOne.mockResolvedValue(row({ ID: 1, domain: 'getmasset.com' }));
   mockDomain.findAll.mockResolvedValue([]);
   mockKeyword.count.mockResolvedValue(0);
   mockEvent.count.mockResolvedValue(0);
   mockGoal.count.mockResolvedValue(0);
   mockKeyword.findAll.mockResolvedValue([]);
   mockEvent.findAll.mockResolvedValue([]);
   mockGoal.findAll.mockResolvedValue([]);
   mockProvider.mockReturnValue(providerStub());
});

describe('GET /api/start-here', () => {
   it('returns mode "setup" with the next step when the domain is half set up, and does not dump analytics', async () => {
      // Owned + keywords tracked, but no tracking events yet -> setup incomplete at "install tracking".
      mockKeyword.count.mockResolvedValue(5);
      mockEvent.count.mockResolvedValue(0);
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.mode).toBe('setup');
      expect(res.payload.domain).toBe('getmasset.com');
      expect(res.payload.percentComplete).toBeGreaterThan(0);
      expect(res.payload.percentComplete).toBeLessThan(100);
      expect(res.payload.nextStep).toBe('Install the tracking script');
      expect(res.payload.nextTool).toContain('install_instructions');
      // It stopped at setup: no analytics dashboard fields leaked.
      expect(res.payload.rendered).toBeUndefined();
      expect(res.payload.nextSteps).toBeUndefined();
      // And it did NOT do the expensive dashboard reads.
      expect(mockKeyword.findAll).not.toHaveBeenCalled();
      expect(mockProvider).not.toHaveBeenCalled();
   });

   it('returns mode "ready" with a headline, top action, the entry_pages pointer, and a rendered block', async () => {
      // Fully set up: owned + keywords + recent events + a goal.
      mockKeyword.count.mockResolvedValue(3);
      mockEvent.count.mockResolvedValue(50);
      mockGoal.count.mockResolvedValue(1);
      // Dashboard reads: a striking-distance keyword, AI-referred sessions, traffic.
      mockKeyword.findAll.mockResolvedValue([
         kw('dam mcp', 14, '["https://getmasset.com/mcp"]', '/mcp', JSON.stringify({ '2026-05-01': 20, '2026-06-01': 14 })),
      ]);
      mockEvent.findAll
         .mockResolvedValueOnce([
            pv('A', '/', 'direct', false, '2026-06-10T10:00:00.000Z'),
            pv('B', '/', 'ai', false, '2026-06-10T11:00:00.000Z'),
         ])
         .mockResolvedValueOnce([]);
      mockGoal.findAll.mockResolvedValue([
         row({ ID: 7, name: 'Demo Booked', kind: 'page_reached', match_value: '/pricing', match_page: null, match_mode: 'prefix', value: 500 }),
      ]);
      mockProvider.mockReturnValue(providerStub({
         traffic: { pages: [{ url: 'https://getmasset.com/', pathClean: '/', page_views: 120 }], error: null },
         referrals: { sources: [{ name: 'chatgpt.com', type: 'ai', engine: 'ChatGPT', isAI: true, unique_visitors: 9 }], error: null },
         summary: { pageviews: 160, visitors: 50, bounceRate: 40, avgDuration: 30, pagesPerVisit: 1.6, error: null },
      }));

      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com', period: '30d' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.mode).toBe('ready');
      expect(res.payload.domain).toBe('getmasset.com');
      expect(typeof res.payload.headline).toBe('string');
      expect(res.payload.headline).toContain('getmasset.com');
      // The single most important thing to do now is present.
      expect(typeof res.payload.topAction).toBe('string');
      expect(res.payload.topAction.length).toBeGreaterThan(0);
      // The curated pointers ALWAYS surface entry_pages (the #3 brief requirement).
      const tools = res.payload.nextSteps.map((p: any) => p.tool);
      expect(tools).toContain('entry_pages');
      expect(tools).toContain('striking_distance');
      expect(tools).toContain('dashboard');
      const aiLanding = res.payload.nextSteps.find((p: any) => p.tool === 'entry_pages');
      expect(aiLanding.label.toLowerCase()).toContain('ai search');
      // A ready-to-show rendered block.
      expect(typeof res.payload.rendered).toBe('string');
      expect(res.payload.rendered).toContain('START HERE');
   });

   it('returns mode "pick-domain" with the list when no domain is given and several are tracked', async () => {
      mockDomain.findAll.mockResolvedValue([
         row({ domain: 'getmasset.com' }),
         row({ domain: 's33k.io' }),
      ]);
      const res = makeRes();
      await handler(makeReq({}), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.mode).toBe('pick-domain');
      expect(res.payload.domains).toEqual(expect.arrayContaining(['getmasset.com', 's33k.io']));
      expect(res.payload.message).toContain('2 domains');
   });

   it('returns mode "no-domain" when no domain is given and none are tracked', async () => {
      mockDomain.findAll.mockResolvedValue([]);
      const res = makeRes();
      await handler(makeReq({}), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.mode).toBe('no-domain');
   });

   it('uses the single tracked domain automatically when no domain is given', async () => {
      mockDomain.findAll.mockResolvedValue([row({ domain: 'getmasset.com' })]);
      // Not yet set up at all -> setup mode for that one domain.
      const res = makeRes();
      await handler(makeReq({}), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.mode).toBe('setup');
      expect(res.payload.domain).toBe('getmasset.com');
   });

   it('answers a not-owned domain as a setup-style 200 (never a wall), not a 403', async () => {
      mockDomain.findOne.mockResolvedValue(null); // resolveDomainAccess -> not owned
      const res = makeRes();
      await handler(makeReq({ domain: 'someoneelse.com' }), res);
      expect(res.statusCode).toBe(200);
      expect(res.payload.mode).toBe('setup');
      expect(res.payload.percentComplete).toBe(0);
   });

   it('405s on a non-GET method', async () => {
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }, 'POST'), res);
      expect(res.statusCode).toBe(405);
   });

   it('401s when not authorized', async () => {
      mockAuthorize.mockResolvedValue({ authorized: false, account: null, error: 'Not authorized' });
      const res = makeRes();
      await handler(makeReq({ domain: 'getmasset.com' }), res);
      expect(res.statusCode).toBe(401);
   });
});
