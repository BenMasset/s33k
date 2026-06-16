/**
 * Tests for GET /api/entry-pages (pages/api/entry-pages.ts).
 *
 * The route is a SEGMENTATION + JOIN, not new collection: it takes the provider's
 * entry pages (with an approximated first-touch source split), joins each to its
 * tracked keywords/rank and its AI referrals, and synthesizes a per-page status.
 *
 * Contracts under test:
 *   1. Ownership gate: a caller that does not own the domain gets 403 and no read.
 *   2. The join: a page's tracked keywords (by target_page) and AI referrals (by
 *      landing_path) are attached, and the status is the right one.
 *   3. The five statuses each surface for the right signal combination.
 *   4. Honesty: sourcesNote (approximated per-page sources) and aiReferralNote (no
 *      per-landing-page AI detail) are surfaced.
 *   5. Graceful degradation: a referral throw and a keyword read failure each
 *      degrade one signal, never a 500.
 *   6. The summary (top landing pages, biggest ranking-not-landing gap, AI-landing
 *      pages, status counts) is built from the joined records.
 *
 * The route's heavy deps (db, Domain, Keyword, authorize, the analytics provider) are
 * mocked so the handler's join/classification logic is exercised in isolation.
 */

import handler from '../../pages/api/entry-pages';
import { getAnalyticsProvider } from '../../utils/analytics';
import Keyword from '../../database/models/keyword';

jest.mock('sequelize', () => ({ __esModule: true, Op: { in: Symbol('in'), gte: Symbol('gte') } }));
jest.mock('../../database/database', () => ({ __esModule: true, default: { sync: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../utils/authorize', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../database/models/domain', () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock('../../database/models/keyword', () => ({ __esModule: true, default: { findAll: jest.fn() } }));
jest.mock('../../utils/analytics', () => {
   const actual = jest.requireActual('../../utils/analytics');
   return { __esModule: true, ...actual, getAnalyticsProvider: jest.fn() };
});

import authorize from '../../utils/authorize';
import Domain from '../../database/models/domain';

const mockedAuthorize = authorize as unknown as jest.Mock;
const mockedDomainFindOne = (Domain as unknown as { findOne: jest.Mock }).findOne;
const mockedFindAll = (Keyword as unknown as { findAll: jest.Mock }).findAll;
const mockedGetProvider = getAnalyticsProvider as jest.Mock;

const ZERO = { direct: 0, referral: 0, search: 0, ai: 0 };

/** A DB-row stand-in: the route calls .get({ plain: true }) on each row. */
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

const entryPage = (over: Record<string, unknown> = {}) => ({
   page: '/',
   pathClean: '/',
   entries: 100,
   sources: { ...ZERO },
   sourcesApproximated: true,
   ...over,
});

/** Build a provider stub with controllable entry pages + referral behavior. */
const providerStub = (opts: {
   entry: { pages: any[], siteSources?: any, sourcesNote?: string | null, error?: string | null },
   referral?: { sources?: any[], error?: string | null },
   referralThrows?: boolean,
}) => ({
   getEntryPages: jest.fn(async () => ({
      pages: opts.entry.pages,
      siteSources: opts.entry.siteSources ?? { ...ZERO },
      sourcesNote: opts.entry.sourcesNote ?? 'approximated note',
      error: opts.entry.error ?? null,
   })),
   getReferralSources: jest.fn(async () => {
      if (opts.referralThrows) { throw new Error('referral backend exploded'); }
      return { sources: opts.referral?.sources ?? [], error: opts.referral?.error ?? null };
   }),
});

const makeReqRes = (query: Record<string, string>) => {
   const req = { method: 'GET', query } as any;
   const captured: { status: number, body: any } = { status: 0, body: null };
   const res: any = {
      status(code: number) { captured.status = code; return res; },
      json(payload: any) { captured.body = payload; return res; },
   };
   return { req, res, captured };
};

beforeEach(() => {
   jest.clearAllMocks();
   mockedAuthorize.mockResolvedValue({ authorized: true, account: { ID: 1 } });
   mockedDomainFindOne.mockResolvedValue({ ID: 1, domain: 'getmasset.com' });
   mockedFindAll.mockResolvedValue([]);
});

describe('GET /api/entry-pages ownership gate', () => {
   it('403s a caller that does not own the domain and never reads analytics', async () => {
      mockedDomainFindOne.mockResolvedValue(null);
      const stub = providerStub({ entry: { pages: [] } });
      mockedGetProvider.mockReturnValue(stub);

      const { req, res, captured } = makeReqRes({ domain: 'someone-elses.com' });
      await handler(req, res);

      expect(captured.status).toBe(403);
      expect(stub.getEntryPages).not.toHaveBeenCalled();
   });

   it('400s when domain is missing', async () => {
      mockedGetProvider.mockReturnValue(providerStub({ entry: { pages: [] } }));
      const { req, res, captured } = makeReqRes({});
      await handler(req, res);
      expect(captured.status).toBe(400);
   });

   it('401s when not authorized', async () => {
      mockedAuthorize.mockResolvedValue({ authorized: false, error: 'nope' });
      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);
      expect(captured.status).toBe(401);
   });
});

describe('GET /api/entry-pages join + status classification', () => {
   it('working: a page that ranks AND lands from search', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ pathClean: '/', entries: 100, sources: { direct: 40, referral: 0, search: 60, ai: 0 } })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const home = captured.body.entryPages.find((p: any) => p.pathClean === '/');
      expect(home.status).toBe('working');
      expect(home.keywords).toEqual([{ keyword: 'masset', rank: 1 }]);
   });

   it('ranking-not-landing: ranks but no non-direct entry traffic', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/pricing' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ page: '/pricing', pathClean: '/pricing', entries: 3, sources: { ...ZERO, direct: 3 } })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      const pricing = captured.body.entryPages.find((p: any) => p.pathClean === '/pricing');
      expect(pricing.status).toBe('ranking-not-landing');
      expect(captured.body.summary.biggestRankingNotLandingGap).toEqual({ page: '/pricing', entries: 3, keywords: 1 });
   });

   it('brand-direct: lots of referral/direct entries but no tracked ranking', async () => {
      mockedFindAll.mockResolvedValue([]); // no keywords tracked at all
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ page: '/blog', pathClean: '/blog', entries: 80, sources: { direct: 50, referral: 30, search: 0, ai: 0 } })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      const blog = captured.body.entryPages.find((p: any) => p.pathClean === '/blog');
      expect(blog.status).toBe('brand-direct');
   });

   it('opportunity: entry traffic but neither ranking nor AI', async () => {
      mockedFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ page: '/x', pathClean: '/x', entries: 10, sources: { direct: 10, referral: 0, search: 0, ai: 0 } })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      const x = captured.body.entryPages.find((p: any) => p.pathClean === '/x');
      expect(x.status).toBe('opportunity');
   });

   it('ai-landing: attributes per-page AI referrals by landing_path and flips status to ai-landing', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ pathClean: '/', entries: 100, sources: { direct: 50, referral: 0, search: 50, ai: 0 } })] },
         referral: {
            sources: [
               { name: 'chatgpt.com', type: 'ai', engine: 'ChatGPT', isAI: true, unique_visitors: 9, landing_path: '/' },
               { name: 'google.com', type: 'search', engine: null, isAI: false, unique_visitors: 50, landing_path: '/' },
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      const home = captured.body.entryPages.find((p: any) => p.pathClean === '/');
      // Only the AI source (9) is attributed, not the non-AI search source.
      expect(home.aiReferrals).toBe(9);
      expect(home.status).toBe('ai-landing');
      expect(captured.body.aiReferralNote).toBeNull();
      expect(captured.body.summary.aiLandingPages).toEqual([{ page: '/', entries: 100, aiReferrals: 9 }]);
   });

   it('ai-landing also fires from the approximated AI source share when no landing_path detail exists', async () => {
      mockedFindAll.mockResolvedValue([]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ page: '/ai', pathClean: '/ai', entries: 20, sources: { direct: 10, referral: 0, search: 0, ai: 10 } })] },
         // AI referral exists but is site-wide (no landing_path), so per-page aiReferrals stays 0.
         referral: { sources: [{ name: 'ChatGPT', type: 'ai', engine: 'ChatGPT', isAI: true, unique_visitors: 5 }] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      const ai = captured.body.entryPages.find((p: any) => p.pathClean === '/ai');
      expect(ai.aiReferrals).toBe(0);
      expect(ai.status).toBe('ai-landing');
      expect(captured.body.aiReferralNote).toMatch(/no per-landing-page detail/i);
   });

   it('matches keyword target_page and AI landing_path by clean path (trailing slash / query)', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 9, keyword: 'mcp', target_page: '/software/mcp' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ page: '/software/mcp', pathClean: '/software/mcp', entries: 30, sources: { ...ZERO, search: 20 } })] },
         referral: {
            sources: [{
               name: 'perplexity.ai', type: 'ai', engine: 'Perplexity', isAI: true, unique_visitors: 4, landing_path: '/software/mcp/?utm=ai',
            }],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      const mcp = captured.body.entryPages.find((p: any) => p.pathClean === '/software/mcp');
      expect(mcp.keywords).toEqual([{ keyword: 'mcp', rank: 1 }]);
      expect(mcp.aiReferrals).toBe(4);
      expect(mcp.status).toBe('ai-landing');
   });
});

describe('GET /api/entry-pages honesty + graceful degradation', () => {
   it('surfaces the approximated-source note and the analytics error from the provider', async () => {
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [], sourcesNote: 'sources are approximated', error: 'referrer fetch failed' },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.sourcesNote).toBe('sources are approximated');
      expect(captured.body.analyticsError).toBe('referrer fetch failed');
   });

   it('never 500s when the referral fetch throws; still returns entry pages with referralError set', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ pathClean: '/', entries: 100, sources: { direct: 40, referral: 0, search: 60, ai: 0 } })] },
         referralThrows: true,
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      expect(captured.body.referralError).toMatch(/exploded/i);
      const home = captured.body.entryPages.find((p: any) => p.pathClean === '/');
      expect(home).toBeDefined();
      expect(home.aiReferrals).toBe(0);
      // Without AI, the page still ranks + lands -> working.
      expect(home.status).toBe('working');
   });

   it('degrades to "no tracked keywords" when the keyword read fails, still 200', async () => {
      mockedFindAll.mockRejectedValue(new Error('db down'));
      mockedGetProvider.mockReturnValue(providerStub({
         entry: { pages: [entryPage({ pathClean: '/', entries: 100, sources: { direct: 40, referral: 0, search: 60, ai: 0 } })] },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      expect(captured.status).toBe(200);
      const home = captured.body.entryPages.find((p: any) => p.pathClean === '/');
      expect(home.keywords).toEqual([]);
      // No tracked keyword + non-direct traffic -> brand-direct.
      expect(home.status).toBe('brand-direct');
   });

   it('builds the summary (top pages sorted by entries, status counts) across mixed pages', async () => {
      mockedFindAll.mockResolvedValue([keywordRow({ ID: 1, keyword: 'masset', target_page: '/big' })]);
      mockedGetProvider.mockReturnValue(providerStub({
         entry: {
            pages: [
               entryPage({ page: '/small', pathClean: '/small', entries: 5, sources: { direct: 5, referral: 0, search: 0, ai: 0 } }),
               entryPage({ page: '/big', pathClean: '/big', entries: 200, sources: { direct: 100, referral: 0, search: 100, ai: 0 } }),
            ],
         },
      }));

      const { req, res, captured } = makeReqRes({ domain: 'getmasset.com' });
      await handler(req, res);

      // Sorted by entries desc.
      expect(captured.body.entryPages.map((p: any) => p.pathClean)).toEqual(['/big', '/small']);
      expect(captured.body.summary.topLandingPages[0]).toEqual({ page: '/big', entries: 200, status: 'working' });
      expect(captured.body.summary.statusCounts.working).toBe(1);
      expect(captured.body.summary.statusCounts.opportunity).toBe(1);
      // statusLegend is exposed so a client can render the labels.
      expect(captured.body.statusLegend.working.length).toBeGreaterThan(10);
   });
});
