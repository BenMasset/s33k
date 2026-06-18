/**
 * Tests for the AI Visibility Funnel synthesis (pages/api/ai-visibility.ts).
 *
 * The funnel joins two first-party signals s33k already collects, never querying
 * an LLM: AI CRAWLER hits (CrawlerHit rows: which engines are LEARNING about the
 * site, per page) and AI REFERRALS (analytics referrals: which engines actually
 * SEND traffic). The contract under test is the synthesis math and the graceful
 * degradation, exercised through the handler with its heavy deps mocked:
 *
 *   1. Funnel math: totalAICrawls, totalAIReferrals, and crawlToReferralRate
 *      (the share of AI-crawled pages that also receive AI referral traffic).
 *   2. Per-PAGE status from the crawl-vs-cite cross: ai-visible (crawled AND
 *      cited), crawled-not-cited (crawled, no referral), cited-not-crawled
 *      (referral, no crawl), ai-invisible (no AI crawl at all).
 *   3. Per-ENGINE status: advocate (crawls + refers), aware-not-recommending
 *      (crawls, no refers), absent. Plus topAdvocate and biggestGap.
 *   4. Owner-to-engine join: a Google-Extended crawl and a Gemini referral fold
 *      into ONE engine (Gemini), proving the two halves join on one name.
 *   5. Graceful degradation: a thrown crawler read, a thrown referral read, and
 *      empty inputs each return 200 with the funnel intact (never a 500), with
 *      the matching error field set.
 *   6. Site-wide referrals (no landing_path): engine-level referrals and totals
 *      stay accurate, per-page citation is not attributed, and a note explains it.
 *
 * Non-AI crawler hits and non-AI referral sources are filtered upstream, so the
 * route only ever sees AI rows; the citability audit (utils/citability-audit.ts)
 * is mocked here and covered in its own suite. db, the Domain and CrawlerHit
 * models, authorize, and the analytics provider are all mocked: no DB, no network.
 */

// ai-visibility.ts imports { Op } from 'sequelize'. Stub it so jest never has to
// transform sequelize's ESM uuid dependency; the model is mocked, so Op is only a
// unique object key in the CrawlerHit query (which we do not assert on).
jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) }, ensureSynced: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/crawlerHit', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});
// The optional enrichment fetches real pages; stub it so the synthesis stays pure.
// Its own behavior is covered in __tests__/utils/citability-audit.test.ts.
jest.mock('../../utils/citability-audit', () => ({
   __esModule: true,
   auditCitability: jest.fn(async () => ({ audited: true, pages: [], domainScore: 0, llmsTxtFound: false, note: 'stub' })),
}));

// eslint-disable-next-line import/first
import handler from '../../pages/api/ai-visibility';
// eslint-disable-next-line import/first
import { getAnalyticsProvider } from '../../utils/analytics';
// eslint-disable-next-line import/first
import { auditCitability } from '../../utils/citability-audit';
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
const mockedAuditCitability = auditCitability as unknown as jest.Mock;

/** A minimal Next-style req/res pair capturing status + json. */
const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query } as any;
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

/** An AI ReferralSource stand-in. isAI is true by default (the route keeps AI only). */
const refRow = (over: Record<string, unknown> = {}) => ({
   name: 'chatgpt.com',
   type: 'ai',
   engine: 'ChatGPT',
   isAI: true,
   unique_visitors: 5,
   ...over,
});

/** Build a provider stub from crawler rows and referral sources. */
const providerStub = (opts: { referral?: { sources?: any[], error?: string | null }, referralThrows?: boolean }) => ({
   getReferralSources: jest.fn(async () => {
      if (opts.referralThrows) { throw new Error('referral backend exploded'); }
      return { sources: opts.referral?.sources ?? [], error: opts.referral?.error ?? null };
   }),
});

beforeEach(() => {
   jest.clearAllMocks();
   // Authorized admin caller and an owned domain so the route reaches the synthesis.
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedCrawlerFindAll.mockResolvedValue([]);
   mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));
});

describe('AI Visibility funnel: math + status classification', () => {
   it('classifies a page crawled AND cited as ai-visible and the engine as an advocate', async () => {
      mockedCrawlerFindAll.mockResolvedValue([
         crawlRow({ bot: 'GPTBot', owner: 'OpenAI', path: '/pricing' }),
         crawlRow({ bot: 'GPTBot', owner: 'OpenAI', path: '/pricing', hitAt: '2026-06-11T00:00:00.000Z' }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 9, landing_path: '/pricing' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const pricing = captured.body.pages.find((p: any) => p.path === '/pricing');
      expect(pricing.isCrawled).toBe(true);
      expect(pricing.isCited).toBe(true);
      expect(pricing.status).toBe('ai-visible');
      expect(pricing.aiCrawlHits).toBe(2);
      expect(pricing.aiReferralVisitors).toBe(9);

      const chatgpt = captured.body.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.status).toBe('advocate');
      expect(chatgpt.crawls).toBe(2);
      expect(chatgpt.referrals).toBe(9);
   });

   it('classifies a crawled-but-not-cited page and an aware-not-recommending engine', async () => {
      // ClaudeBot crawls /docs but Claude refers nobody.
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/docs' })]);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const docs = captured.body.pages.find((p: any) => p.path === '/docs');
      expect(docs.isCrawled).toBe(true);
      expect(docs.isCited).toBe(false);
      expect(docs.status).toBe('crawled-not-cited');

      const claude = captured.body.engines.find((e: any) => e.engine === 'Claude');
      expect(claude.status).toBe('aware-not-recommending');
      expect(claude.crawls).toBe(1);
      expect(claude.referrals).toBe(0);
   });

   it('classifies a cited-but-not-crawled page (referral with no recorded crawl)', async () => {
      // No crawler hits at all; a referral lands on /blog with a landing_path.
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 3, landing_path: '/blog' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const blog = captured.body.pages.find((p: any) => p.path === '/blog');
      expect(blog.isCrawled).toBe(false);
      expect(blog.isCited).toBe(true);
      expect(blog.status).toBe('cited-not-crawled');
   });

   it('computes crawlToReferralRate as the share of AI-crawled pages that are also cited', async () => {
      // Two AI-crawled pages; only one of them is also cited -> 50%.
      mockedCrawlerFindAll.mockResolvedValue([
         crawlRow({ path: '/a' }),
         crawlRow({ path: '/b' }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ unique_visitors: 4, landing_path: '/a' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.totalAICrawls).toBe(2);
      expect(captured.body.summary.totalAIReferrals).toBe(4);
      expect(captured.body.summary.crawlToReferralRate).toBe(50);
   });

   it('reports crawlToReferralRate null when this provider has no per-landing referral detail', async () => {
      // Per-page crawl-to-referral is NOT attributable when no referral source carries a landing_path
      // (referralLandingAvailable false). A hard 0 would read as a real, terrible funnel, so the route
      // returns null and the note explains it. This replaces the old "0 means no AI-crawled pages"
      // assertion: 0 was lying about un-attributable data. (Genuine-bug fix; see ai-visibility #3.)
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.crawlToReferralRate).toBeNull();
      expect(captured.body.summary.totalAICrawls).toBe(0);
      expect(captured.body.summary.totalAIReferrals).toBe(0);
   });

   it('reports crawlToReferralRate 0 (no divide-by-zero) when landing detail exists but no AI-crawled pages', async () => {
      // referralLandingAvailable is true (a source carries landing_path), so the rate IS attributable;
      // with zero crawled pages it must be a real 0, not null, and must not divide by zero.
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ unique_visitors: 3, landing_path: '/only-cited' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.crawlToReferralRate).toBe(0);
      expect(captured.body.summary.totalAICrawls).toBe(0);
   });

   it('picks the advocate with the most referrals as topAdvocate', async () => {
      // ChatGPT crawls + refers 10; Perplexity crawls + refers 2. Both advocates.
      mockedCrawlerFindAll.mockResolvedValue([
         crawlRow({ bot: 'GPTBot', owner: 'OpenAI', path: '/x' }),
         crawlRow({ bot: 'PerplexityBot', owner: 'Perplexity', path: '/x' }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: {
            sources: [
               refRow({ engine: 'ChatGPT', unique_visitors: 10, landing_path: '/x' }),
               refRow({ engine: 'Perplexity', name: 'perplexity.ai', unique_visitors: 2, landing_path: '/x' }),
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.topAdvocate).toBe('ChatGPT');
   });

   it('reports the engine with the largest crawl-minus-referral gap as biggestGap', async () => {
      // ClaudeBot crawls 5 pages, refers nobody (gap 5). ChatGPT crawls 1, refers 1 (gap 0).
      mockedCrawlerFindAll.mockResolvedValue([
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/1' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/2' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/3' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/4' }),
         crawlRow({ bot: 'ClaudeBot', owner: 'Anthropic', path: '/5' }),
         crawlRow({ bot: 'GPTBot', owner: 'OpenAI', path: '/1' }),
      ]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 1, landing_path: '/1' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.summary.biggestGap).toEqual({ engine: 'Claude', crawls: 5, referrals: 0, gap: 5 });
   });

   it('joins a Google-Extended crawl and a Gemini referral into one engine via the owner-to-engine map', async () => {
      // The crawler owner is "Google"; the referral engine is "Gemini". They must
      // fold into a SINGLE engine row (Gemini) so the funnel joins on one name.
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ bot: 'Google-Extended', owner: 'Google', path: '/g' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'Gemini', name: 'gemini.google.com', unique_visitors: 6, landing_path: '/g' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const geminiRows = captured.body.engines.filter((e: any) => e.engine === 'Gemini');
      expect(geminiRows).toHaveLength(1);
      expect(geminiRows[0].crawls).toBe(1);
      expect(geminiRows[0].referrals).toBe(6);
      expect(geminiRows[0].status).toBe('advocate');
      // No stray "Google" engine row leaked through.
      expect(captured.body.engines.some((e: any) => e.engine === 'Google')).toBe(false);
   });
});

describe('AI Visibility funnel: graceful degradation', () => {
   it('never 500s when the crawler read throws; returns 200 with crawlerError set and an empty crawl side', async () => {
      mockedCrawlerFindAll.mockRejectedValue(new Error('crawler db exploded'));
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 5, landing_path: '/' })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.crawlerError).toMatch(/exploded/i);
      expect(captured.body.summary.totalAICrawls).toBe(0);
      // The referral half still works: ChatGPT is an advocate with no recorded crawl.
      expect(captured.body.summary.totalAIReferrals).toBe(5);
      const chatgpt = captured.body.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.status).toBe('advocate');
   });

   it('never 500s when the referral read throws; returns 200 with referralError set and the crawl side intact', async () => {
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ path: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({ referralThrows: true }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toMatch(/exploded/i);
      expect(captured.body.summary.totalAIReferrals).toBe(0);
      // The crawl side is still reported: the page is crawled-not-cited.
      const home = captured.body.pages.find((p: any) => p.path === '/');
      expect(home.status).toBe('crawled-not-cited');
   });

   it('returns an empty-but-valid funnel (200) when both inputs are empty', async () => {
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.pages).toEqual([]);
      expect(captured.body.engines).toEqual([]);
      expect(captured.body.summary).toEqual({
         totalAICrawls: 0,
         totalAIReferrals: 0,
         // No referral source carries a landing_path, so per-page crawl-to-referral is not
         // attributable: null, not a misleading 0. (Genuine-bug fix; see ai-visibility #3.)
         crawlToReferralRate: null,
         topAdvocate: null,
         biggestGap: null,
      });
   });

   it('surfaces a provider referral error string without failing the funnel', async () => {
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ path: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [], error: 'Not supported by this provider' } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toBe('Not supported by this provider');
      expect(captured.body.summary.totalAICrawls).toBe(1);
   });
});

describe('AI Visibility funnel: site-wide referrals (no per-landing-page detail)', () => {
   it('keeps engine-level referrals and totals accurate but does not attribute per-page citation, with a note', async () => {
      // Page IS crawled. The AI referral has NO landing_path (site-wide reporting).
      mockedCrawlerFindAll.mockResolvedValue([crawlRow({ bot: 'GPTBot', owner: 'OpenAI', path: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         referral: { sources: [refRow({ engine: 'ChatGPT', unique_visitors: 12 })] }, // no landing_path
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralLandingAvailable).toBe(false);
      // Engine-level referral total is still correct.
      const chatgpt = captured.body.engines.find((e: any) => e.engine === 'ChatGPT');
      expect(chatgpt.referrals).toBe(12);
      expect(captured.body.summary.totalAIReferrals).toBe(12);
      // But the crawled page cannot be marked cited without a landing path.
      const home = captured.body.pages.find((p: any) => p.path === '/');
      expect(home.isCited).toBe(false);
      expect(home.status).toBe('crawled-not-cited');
      expect(captured.body.note).toMatch(/site-wide/i);
   });
});

describe('AI Visibility funnel: optional citability enrichment trigger', () => {
   it('runs the citability audit only when first-party AI data is thin (few crawls, no referrals)', async () => {
      // Thin: 0 AI crawls and 0 AI referrals -> dataIsThin true -> audit runs.
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.dataIsThin).toBe(true);
      expect(mockedAuditCitability).toHaveBeenCalledTimes(1);
      expect(captured.body.citabilityAudit).not.toBeNull();
      expect(captured.body.note).toMatch(/thin/i);
   });

   it('skips the citability audit when first-party AI data is healthy', async () => {
      // 10+ AI crawls clears the thin threshold.
      const manyCrawls = Array.from({ length: 12 }, (_v, i) => crawlRow({ path: `/p${i}` }));
      mockedCrawlerFindAll.mockResolvedValue(manyCrawls);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.dataIsThin).toBe(false);
      expect(mockedAuditCitability).not.toHaveBeenCalled();
      expect(captured.body.citabilityAudit).toBeNull();
   });

   it('does not let a thrown citability audit break the funnel (still 200)', async () => {
      mockedCrawlerFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({ referral: { sources: [] } }));
      mockedAuditCitability.mockRejectedValueOnce(new Error('audit fetch exploded'));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.dataIsThin).toBe(true);
      // The audit failed, so it degrades to null rather than throwing.
      expect(captured.body.citabilityAudit).toBeNull();
   });
});
