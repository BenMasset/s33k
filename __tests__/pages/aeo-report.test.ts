/**
 * Tests for the prebuilt AEO snapshot report (pages/api/aeo-report.ts).
 *
 * aeo_report BUNDLES three first-party AEO signals into one sectioned response,
 * never querying an LLM: AI REFERRALS (which AI engines sent visitors, from the
 * analytics provider's classified referral sources) and AI CRAWLERS (which AI
 * bots hit the site, from CrawlerHit rows), joined into a per-engine FUNNEL
 * SUMMARY (crawls vs referrals, the leading-indicator-to-outcome view). The
 * contract under test, exercised through the handler with its heavy deps mocked:
 *
 *   1. aiReferrals: AI sources aggregate per engine; aiSharePct is AI visitors
 *      over ALL referred visitors (AI + non-AI), so non-AI sources count in the
 *      denominator but not the byEngine list.
 *   2. aiCrawlers: AI-engine CrawlerHit rows aggregate per bot (hits + lastSeen);
 *      non-AI crawler rows count toward allCrawlerHits but not aiEngineHits.
 *   3. funnelSummary: per-engine crawls-vs-referrals join via OWNER_TO_ENGINE (a
 *      Google crawl + a Gemini referral fold into ONE Gemini row), status
 *      (advocate / aware-not-recommending / absent), topAdvocate, biggestGap.
 *   4. note: thin-data honesty (no crawls + no referrals) and the crawl-but-no-
 *      referral early state.
 *   5. Graceful degradation: a thrown referral read and a thrown crawler read
 *      each return 200 with the matching error field set and the other section
 *      intact (never a 500). Ownership 403 and the GET guard.
 *
 * db, the Domain and CrawlerHit models, authorize, and the analytics provider
 * are all mocked: no real models are imported, no DB, no network. We stub
 * 'sequelize' so jest never transforms its ESM uuid dep; the model is mocked, so
 * Op is only a unique key in the CrawlerHit query we do not assert on.
 */

jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/crawlerHit', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

// eslint-disable-next-line import/first
import handler from '../../pages/api/aeo-report';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';
// eslint-disable-next-line import/first
import authorize from '../../utils/authorize';
// eslint-disable-next-line import/first
import Domain from '../../database/models/domain';
// eslint-disable-next-line import/first
import CrawlerHit from '../../database/models/crawlerHit';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedCrawlerFindAll = (CrawlerHit as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

/** A minimal Next-style req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>, method = 'GET') => {
   const req = { method, query } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

/** A CrawlerHit row stand-in (raw: true rows). Defaults to an AI-engine hit. */
const crawlRow = (over: Record<string, unknown> = {}) => ({
   bot: 'GPTBot',
   owner: 'OpenAI',
   isAiEngine: true,
   path: '/',
   userAgent: 'GPTBot/1.0',
   hitAt: '2026-06-10T00:00:00.000Z',
   ...over,
});

/** An AI ReferralSource stand-in. isAI is true by default. */
const refRow = (over: Record<string, unknown> = {}) => ({
   name: 'chatgpt.com',
   type: 'ai',
   engine: 'ChatGPT',
   isAI: true,
   unique_visitors: 5,
   ...over,
});

/** Build a provider stub from referral sources, optionally throwing. */
const providerStub = (opts: { sources?: any[], error?: string | null, throws?: boolean } = {}) => ({
   getReferralSources: jest.fn(async () => {
      if (opts.throws) { throw new Error('referral backend exploded'); }
      return { sources: opts.sources ?? [], error: opts.error ?? null };
   }),
});

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller and an owned domain so the route reaches the report.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedCrawlerFindAll.mockResolvedValue([]);
   mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
});

describe('aeo_report: guards and ownership', () => {
   it('returns 405 for a non-GET method', async () => {
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' }, 'POST');
      await handler(req, res);
      expect(captured.status).toBe(405);
   });

   it('returns 401 when authorize fails', async () => {
      mockedAuthorize.mockResolvedValue({ authorized: false, error: 'no key' });
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(401);
   });

   it('returns 400 when the domain is missing', async () => {
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);
      expect(captured.status).toBe(400);
   });

   it('returns 403 when the caller does not own the domain', async () => {
      mockedDomainFindOne.mockResolvedValue(null);
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(403);
   });
});

describe('aeo_report: aiReferrals section', () => {
   it('aggregates AI sources per engine and computes aiSharePct over ALL referred visitors', async () => {
      // 9 + 3 AI visitors (ChatGPT, Perplexity) over 12 + 8 = 20 total referred -> 60%.
      mockedGetProvider.mockReturnValue(providerStub({
         sources: [
            refRow({ engine: 'ChatGPT', unique_visitors: 9, page_views: 11 }),
            refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 3 }),
            { name: 'google.com', type: 'search', engine: null, isAI: false, unique_visitors: 8 },
         ],
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const { byEngine, totals } = captured.body.aiReferrals;
      // Non-AI google.com is excluded from byEngine but counted in the denominator.
      expect(byEngine.map((e: any) => e.engine)).toEqual(['ChatGPT', 'Perplexity']);
      expect(byEngine[0]).toEqual({ engine: 'ChatGPT', visitors: 9, pageViews: 11 });
      expect(totals.aiVisitors).toBe(12);
      expect(totals.allReferredVisitors).toBe(20);
      expect(totals.aiSharePct).toBe(60);
   });

   it('reports aiSharePct 0 (no divide-by-zero) when there are no referred visitors', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.aiReferrals.totals).toEqual({ aiVisitors: 0, allReferredVisitors: 0, aiSharePct: 0 });
   });
});

describe('aeo_report: aiCrawlers section', () => {
   it('aggregates AI-engine crawler hits per bot and excludes non-AI bots from aiEngineHits', async () => {
      mockedCrawlerFindAll.mockResolvedValue([
         crawlRow({ bot: 'GPTBot', path: '/a' }),
         crawlRow({ bot: 'GPTBot', path: '/b', hitAt: '2026-06-12T00:00:00.000Z' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/a' }),
         // A non-AI crawler counts toward allCrawlerHits only.
         crawlRow({ bot: 'AhrefsBot', owner: 'Ahrefs', isAiEngine: false }),
      ]);

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const { byBot, totals } = captured.body.aiCrawlers;
      const gptbot = byBot.find((b: any) => b.bot === 'GPTBot');
      expect(gptbot.hits).toBe(2);
      // lastSeen is the most-recent of the two GPTBot hits.
      expect(gptbot.lastSeen).toBe('2026-06-12T00:00:00.000Z');
      expect(byBot.some((b: any) => b.bot === 'AhrefsBot')).toBe(false);
      expect(totals.aiEngineHits).toBe(3);
      expect(totals.allCrawlerHits).toBe(4);
   });
});

describe('aeo_report: funnelSummary section', () => {
   it('joins a Google crawl and a Gemini referral into ONE Gemini engine row via OWNER_TO_ENGINE', async () => {
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ bot: 'Google-Extended', owner: 'Google', path: '/g' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         sources: [refRow({ engine: 'Gemini', name: 'gemini.google.com', unique_visitors: 6 })],
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const gemini = captured.body.funnelSummary.engines.filter((e: any) => e.engine === 'Gemini');
      expect(gemini).toHaveLength(1);
      expect(gemini[0].crawls).toBe(1);
      expect(gemini[0].referrals).toBe(6);
      expect(gemini[0].status).toBe('advocate');
      // No stray "Google" engine row leaked through.
      expect(captured.body.funnelSummary.engines.some((e: any) => e.engine === 'Google')).toBe(false);
   });

   it('classifies status and picks topAdvocate and biggestGap', async () => {
      // ChatGPT crawls 1 + refers 10 (advocate). ClaudeBot crawls 4, refers 0 (aware, gap 4).
      mockedCrawlerFindAll.mockResolvedValue([
         crawlRow({ bot: 'GPTBot', owner: 'OpenAI', path: '/1' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/1' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/2' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/3' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/4' }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         sources: [refRow({ engine: 'ChatGPT', unique_visitors: 10 })],
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const { funnelSummary } = captured.body;
      expect(funnelSummary.totalAICrawls).toBe(5);
      expect(funnelSummary.totalAIReferrals).toBe(10);
      expect(funnelSummary.topAdvocate).toBe('ChatGPT');
      expect(funnelSummary.biggestGap).toEqual({ engine: 'Claude', crawls: 4, referrals: 0, gap: 4 });
      const claude = funnelSummary.engines.find((e: any) => e.engine === 'Claude');
      expect(claude.status).toBe('aware-not-recommending');
   });
});

describe('aeo_report: notes and degradation', () => {
   it('sets a thin-data note when there are no AI crawls and no AI referrals', async () => {
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.note).toMatch(/thin/i);
      expect(captured.body.funnelSummary.topAdvocate).toBeNull();
      expect(captured.body.funnelSummary.biggestGap).toBeNull();
   });

   it('sets the crawl-but-no-referral note when bots crawl but no engine refers', async () => {
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ path: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({ sources: [] }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.note).toMatch(/crawl is the leading indicator/i);
   });

   it('never 500s when the referral read throws: returns 200 with referralError and the crawler section intact', async () => {
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ path: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({ throws: true }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toMatch(/exploded/i);
      expect(captured.body.aiReferrals.totals.aiVisitors).toBe(0);
      // The crawler half still works.
      expect(captured.body.aiCrawlers.totals.aiEngineHits).toBe(1);
   });

   it('never 500s when the crawler read throws: returns 200 with crawlerError and the referral section intact', async () => {
      mockedCrawlerFindAll.mockRejectedValue(new Error('crawler db exploded'));
      mockedGetProvider.mockReturnValue(providerStub({ sources: [refRow({ engine: 'ChatGPT', unique_visitors: 7 })] }));
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(200);
      expect(captured.body.crawlerError).toMatch(/exploded/i);
      expect(captured.body.aiCrawlers.totals.aiEngineHits).toBe(0);
      // The referral half still works: ChatGPT is an advocate with no recorded crawl.
      expect(captured.body.aiReferrals.totals.aiVisitors).toBe(7);
      const chatgpt = captured.body.funnelSummary.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.status).toBe('advocate');
   });
});
