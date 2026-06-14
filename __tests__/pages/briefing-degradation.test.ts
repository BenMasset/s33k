/**
 * Tests for the daily-briefing composer's graceful degradation
 * (pages/api/briefing.ts).
 *
 * The briefing joins every s33k pillar (traffic, human-vs-bot, SEO rank, AI
 * referrals, AI crawlers, engagement) into one narration-ready structure. Its
 * hard contract: a single failing sub-signal must NOT break the briefing. Each
 * pillar is fetched independently; a rejection degrades that one section into a
 * note while the rest of the briefing still builds. The only non-200 paths are
 * auth (401) and a missing domain (400).
 *
 * Contract under test:
 *   1. Happy path: all pillars resolve, status 200, a headline, four sections,
 *      and at least one recommendation.
 *   2. A provider method that REJECTS (e.g. getSummary throws) degrades only its
 *      section into an "unavailable" note; status is still 200 and the other
 *      sections are intact.
 *   3. estimateHumanTraffic rejecting does not break the briefing (200).
 *   4. The CrawlerHit DB query rejecting degrades only the AI/crawler section
 *      (200), not the whole briefing.
 *   5. Many sub-signals failing at once still yields a usable 200 briefing.
 *   6. Auth failure returns 401; a missing domain returns 400.
 *
 * All heavy deps (db, Keyword, CrawlerHit, verifyUser, the analytics provider,
 * estimateHumanTraffic) are mocked. No DB, no network, no LLM.
 */

import handler from '../../pages/api/briefing';
import { getAnalyticsProvider } from '../../utils/analytics';
import { estimateHumanTraffic } from '../../utils/bot-filter';
import Keyword from '../../database/models/keyword';
import CrawlerHit from '../../database/models/crawlerHit';

// briefing.ts imports { Op } from 'sequelize' directly. Mock sequelize to a
// tiny stub so jest does not have to transform sequelize's ESM uuid dependency
// (the model layer is mocked anyway, so Op is never exercised against a real DB).
jest.mock('sequelize', () => ({ __esModule: true, Op: { gte: Symbol('gte') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../utils/verifyUser', () => ({ __esModule: true, default: jest.fn(() => 'authorized') }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../database/models/crawlerHit', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});
jest.mock('../../utils/bot-filter', () => ({ __esModule: true, estimateHumanTraffic: jest.fn() }));

import verifyUser from '../../utils/verifyUser';

const mockedVerify = verifyUser as unknown as jest.Mock;
const mockedKeywordFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedCrawlerFindAll = (CrawlerHit as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;
const mockedEstimate = estimateHumanTraffic as jest.Mock;

/** A DB-row stand-in: the route calls .get({ plain: true }) on each keyword row. */
const keywordRow = (overrides: Record<string, unknown>) => {
   const plain = {
      ID: 1,
      keyword: 'masset',
      domain: 'getmasset.com',
      device: 'desktop',
      country: 'US',
      position: 1,
      url: 'https://getmasset.com/',
      target_page: '/',
      history: '{}',
      tags: '[]',
      lastResult: '[]',
      lastUpdateError: 'false',
      sticky: false,
      ...overrides,
   };
   return { get: () => plain };
};

/** A minimal Next-style GET req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query, headers: {}, url: '/api/briefing' } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/**
 * Build a provider stub. Each pillar method can be made to throw via the
 * `throwOn` set so we can test per-signal degradation.
 */
const providerStub = (throwOn: Set<string> = new Set()) => {
   const guard = (name: string, value: any) => async () => {
      if (throwOn.has(name)) { throw new Error(`${name} backend exploded`); }
      return value;
   };
   return {
      getPageTraffic: guard('getPageTraffic', {
         pages: [
            { url: 'https://getmasset.com/', pathClean: '/', page_views: 80, unique_visitors: 70, bounce_rate: 40, avg_duration: 30 },
            { url: 'https://getmasset.com/software/mcp', pathClean: '/software/mcp', page_views: 20, unique_visitors: 18, bounce_rate: 50, avg_duration: 25 },
         ],
         error: null,
      }),
      getReferralSources: guard('getReferralSources', {
         sources: [
            { name: 'chatgpt.com', engine: 'ChatGPT', isAI: true, unique_visitors: 5 },
            { name: 'google.com', engine: null, isAI: false, unique_visitors: 40 },
         ],
         error: null,
      }),
      getSummary: guard('getSummary', {
         pageviews: 100, visitors: 88, bounceRate: 45, avgDuration: 120, pagesPerVisit: 1.2, error: null,
      }),
      getEngagement: guard('getEngagement', {
         tiers: [{ label: 'Browsed', percentage: 30 }, { label: 'Bounced', percentage: 70 }],
         error: null,
      }),
   };
};

const goodEstimate = {
   estVisitors: 88, estHumanVisitors: 60, estBotVisitors: 28, botSharePct: 32, method: 'test', error: null,
};

beforeEach(() => {
   jest.clearAllMocks();
   mockedVerify.mockReturnValue('authorized');
   mockedKeywordFindAll.mockResolvedValue([
      keywordRow({ ID: 1, keyword: 'masset', target_page: '/', position: 1 }),
      keywordRow({ ID: 2, keyword: 'DAM MCP server', target_page: '/software/mcp', position: 14 }),
   ]);
   mockedCrawlerFindAll.mockResolvedValue([
      { bot: 'GPTBot', owner: 'OpenAI', isAiEngine: true, hitAt: new Date().toJSON() },
   ]);
   mockedEstimate.mockResolvedValue(goodEstimate);
   mockedGetProvider.mockReturnValue(providerStub());
});

describe('briefing composer graceful degradation', () => {
   it('builds a full briefing (200, headline, four sections, recommendations) when all pillars resolve', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      expect(typeof captured.body.headline).toBe('string');
      expect(captured.body.headline.length).toBeGreaterThan(0);
      expect(captured.body.sections).toHaveLength(4);
      expect(Array.isArray(captured.body.recommendations)).toBe(true);
      expect(captured.body.recommendations.length).toBeGreaterThan(0);
      expect(captured.body.generatedFor).toEqual({ domain: 'getmasset.com', period: '30d' });
   });

   it('degrades only the traffic section (still 200) when getSummary rejects', async () => {
      mockedGetProvider.mockReturnValue(providerStub(new Set(['getSummary'])));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.error).toBeNull();
      // All four sections are still present; the traffic one carries the note.
      expect(captured.body.sections).toHaveLength(4);
      const traffic = captured.body.sections.find((s: any) => /human-vs-bot/i.test(s.title));
      expect(traffic.points.join(' ')).toMatch(/unavailable/i);
      // The SEO section is unaffected and still reports the tracked keywords.
      const seo = captured.body.sections.find((s: any) => /Search rank/i.test(s.title));
      expect(seo.points.join(' ')).toMatch(/tracked keywords/i);
   });

   it('does not break the briefing when estimateHumanTraffic rejects', async () => {
      mockedEstimate.mockRejectedValue(new Error('bot-filter backend exploded'));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.sections).toHaveLength(4);
      const traffic = captured.body.sections.find((s: any) => /human-vs-bot/i.test(s.title));
      // The pageview line still rendered (summary resolved); only the bot line degraded.
      expect(traffic.points.join(' ')).toMatch(/pageviews|Human-vs-bot estimate unavailable/i);
   });

   it('degrades only the AI/crawler section when the CrawlerHit query rejects', async () => {
      mockedCrawlerFindAll.mockRejectedValue(new Error('crawler table missing'));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const ai = captured.body.sections.find((s: any) => /AI visibility/i.test(s.title));
      // The crawler query failed -> route treats it as zero hits, not a 500.
      expect(ai).toBeDefined();
      expect(ai.points.join(' ')).toMatch(/crawler/i);
   });

   it('still returns a usable 200 briefing when many sub-signals fail at once', async () => {
      mockedGetProvider.mockReturnValue(providerStub(new Set([
         'getPageTraffic', 'getReferralSources', 'getSummary', 'getEngagement',
      ])));
      mockedEstimate.mockRejectedValue(new Error('estimate down'));
      mockedCrawlerFindAll.mockRejectedValue(new Error('crawler down'));
      mockedKeywordFindAll.mockRejectedValue(new Error('keyword query down'));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.sections).toHaveLength(4);
      expect(Array.isArray(captured.body.recommendations)).toBe(true);
      expect(captured.body.recommendations.length).toBeGreaterThan(0);
      expect(typeof captured.body.headline).toBe('string');
   });

   it('returns 401 when the request is not authorized', async () => {
      mockedVerify.mockReturnValue('This Route Requires a valid Authorization Bearer Token.');
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(401);
   });

   it('returns 400 when the domain is missing', async () => {
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);

      expect(captured.status).toBe(400);
      expect(captured.body.error).toMatch(/domain/i);
   });
});
