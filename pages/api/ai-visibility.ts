import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import CrawlerHit from '../../database/models/crawlerHit';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, ReferralSource } from '../../utils/analytics';
import { cleanPath } from '../../utils/lodd';
import { auditCitability, CitabilityAudit } from '../../utils/citability-audit';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * s33k NEVER sends customer data to a model trainer and has NO model-training
 * pipeline anywhere in the codebase. This route measures AI visibility from
 * first-party, un-gameable behavior s33k already records (AI crawler hits and
 * AI referral traffic) plus a deterministic on-page citability audit. It NEVER
 * queries an LLM and never transmits account data to any external model. Any
 * interpretation happens in the USER's own LLM over MCP. Full trust
 * documentation: SECURITY.md (and the security_facts MCP tool).
 * ============================================================================
 */

/**
 * The AI Visibility Funnel.
 *
 * GET /api/ai-visibility?domain=getmasset.com&period=30d
 *
 * Measures a domain's standing in AI search using only first-party, un-gameable
 * behavior s33k already records: which AI engines CRAWL the site (the leading
 * indicator, from CrawlerHit rows) and which AI engines actually REFER traffic
 * (the outcome, from analytics referrals). It NEVER queries an LLM and never
 * asks an AI engine whether it cites the site.
 *
 * The novel synthesis is the funnel/gap between crawl and referral, per engine
 * and per page:
 *   - per page (pages[]): is the page crawled by AI, cited by AI, both, or
 *     neither, expressed as a status (see PageStatus).
 *   - per engine (engines[]): does the engine crawl and refer (advocate), crawl
 *     but not refer (aware-not-recommending), or neither (absent).
 *   - a funnel summary: total AI crawls, total AI referrals, crawl-to-referral
 *     rate, the top advocate engine, and the biggest crawl-vs-referral gap.
 *
 * When that first-party data is thin (few/no AI crawls AND no AI referrals), the
 * response ALSO carries an optional AI-citability audit: it fetches the domain's
 * top pages and scores their AI-readiness (llms.txt, Markdown twins, JSON-LD,
 * answer-shaped content). The audit is deterministic and never queries an LLM.
 *
 * Follows the wired analytics-route pattern: authorize() then verify the caller
 * owns the domain (403 otherwise). Degrades gracefully and never 500s on a
 * sub-signal failure.
 */

/**
 * A page's standing in AI search, from the crawl-vs-cite cross.
 *   ai-visible        crawled by AI AND cited (referred) by AI: the goal state.
 *   crawled-not-cited AI knows the page (crawled) but does not recommend it yet.
 *   cited-not-crawled referrals exist but no AI crawl recorded (rare; usually a
 *                     crawl that predates the window, or referral-only landing).
 *   ai-invisible      no AI crawl recorded for the page at all.
 */
type PageStatus = 'ai-visible' | 'crawled-not-cited' | 'cited-not-crawled' | 'ai-invisible';

/**
 * An engine's standing.
 *   advocate               crawls the site AND refers traffic: working for you.
 *   aware-not-recommending crawls but sends no traffic yet: aware, not citing.
 *   absent                 neither crawls nor refers in the window.
 */
type EngineStatus = 'advocate' | 'aware-not-recommending' | 'absent';

type PageCrawlerRef = {
   bot: string,
   owner: string | null,
   hits: number,
   lastSeen: string,
};

type PageReferralRef = {
   engine: string,
   visitors: number,
};

type AiVisibilityPage = {
   path: string,
   isCrawled: boolean,
   isCited: boolean,
   status: PageStatus,
   aiCrawlHits: number,
   aiReferralVisitors: number,
   crawledBy: PageCrawlerRef[],
   referredBy: PageReferralRef[],
};

type AiVisibilityEngine = {
   engine: string,
   owner: string | null,
   status: EngineStatus,
   crawls: number,
   crawledPages: string[],
   referrals: number,
   referredPages: string[],
};

type FunnelSummary = {
   totalAICrawls: number,
   totalAIReferrals: number,
   /** Percent of AI-crawled pages that also receive AI referral traffic (0..100). */
   crawlToReferralRate: number,
   /** The engine doing the most for you (advocate with the most referrals), or null. */
   topAdvocate: string | null,
   /** The engine with the largest crawl-minus-referral gap (most aware, least citing). */
   biggestGap: { engine: string, crawls: number, referrals: number, gap: number } | null,
};

type AiVisibilityResponse = {
   domain?: string,
   period?: string,
   engines?: AiVisibilityEngine[],
   pages?: AiVisibilityPage[],
   summary?: FunnelSummary,
   dataIsThin?: boolean,
   citabilityAudit?: CitabilityAudit | null,
   crawlerError?: string | null,
   referralError?: string | null,
   referralLandingAvailable?: boolean,
   note?: string | null,
   error?: string | null,
};

/** A normalized crawler hit row pulled from the DB. */
type CrawlerRow = {
   bot: string,
   owner: string | null,
   isAiEngine: boolean,
   path: string,
   userAgent: string,
   hitAt: string,
};

/**
 * Map a normalized engine-owner label (Google, OpenAI, ...) used by the crawler
 * classifier to the referral engine label (Gemini, ChatGPT, ...) used by the
 * referral classifier, so the two halves of the funnel join on one engine name.
 * Falls back to the owner when there is no distinct referral name.
 */
const OWNER_TO_ENGINE: Record<string, string> = {
   OpenAI: 'ChatGPT',
   Anthropic: 'Claude',
   Perplexity: 'Perplexity',
   Google: 'Gemini',
   Microsoft: 'Copilot',
   Meta: 'Meta AI',
   'You.com': 'You.com',
};

/**
 * Convert a period string (e.g. "30d", "7d", "4w") into a cutoff Date. Mirrors
 * the crawler window parsing in pages/api/ai-crawlers.ts so crawl windows match.
 * @param {string} period - The reporting window.
 * @returns {Date} The earliest hitAt to include.
 */
const periodToCutoff = (period: string): Date => {
   const match = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   let days = 30;
   if (match) {
      const n = Number(match[1]);
      const unit = match[2].toLowerCase();
      const perUnitDays: Record<string, number> = { h: n / 24, d: n, w: n * 7, m: n * 30 };
      days = perUnitDays[unit] ?? 30;
   }
   const ms = Math.max(1, days) * 24 * 60 * 60 * 1000;
   return new Date(Date.now() - ms);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<AiVisibilityResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAiVisibility(req, res, account);
}

const getAiVisibility = async (req: NextApiRequest, res: NextApiResponse<AiVisibilityResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // Verify the caller owns this domain before exposing any of its data. With
   // MULTI_TENANT off, scopeWhere returns {} so this matches the domain by name.
   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      // 1. AI CRAWLERS: read recorded crawler hits for the window, keep AI-engine
      //    hits only, and key them per page. Same source as /api/ai-crawlers, but
      //    that route discards the per-page breakdown; here we keep it.
      let crawlerError: string | null = null;
      let crawlerRows: CrawlerRow[] = [];
      try {
         const cutoff = periodToCutoff(period).toJSON();
         crawlerRows = await CrawlerHit.findAll({
            where: { domain, hitAt: { [Op.gte]: cutoff } },
            order: [['hitAt', 'DESC']],
            raw: true,
         }) as unknown as CrawlerRow[];
      } catch (crawlErr) {
         crawlerError = crawlErr instanceof Error ? crawlErr.message : String(crawlErr);
         crawlerRows = [];
      }
      const aiCrawlerRows = crawlerRows.filter((r) => r.isAiEngine);

      // 2. AI REFERRALS: read referral sources from the analytics provider and
      //    keep AI engines only. Same classification path as /api/ai-referrals.
      //    Most providers report referrals site-wide (no landing_path), in which
      //    case per-page citation cannot be attributed and is surfaced honestly.
      let referralError: string | null = null;
      let aiReferralSources: ReferralSource[] = [];
      try {
         const { sources, error: refError } = await getAnalyticsProvider().getReferralSources(domain, period);
         referralError = refError;
         aiReferralSources = (sources || []).filter((s) => s.isAI);
      } catch (refErr) {
         referralError = refErr instanceof Error ? refErr.message : String(refErr);
         aiReferralSources = [];
      }
      const referralLandingAvailable = aiReferralSources.some((s) => Boolean(s.landing_path));

      // 3. Build the per-page funnel. Crawl-keyed pages come from crawler hits;
      //    cite-keyed pages come from referrals only when landing_path exists.
      const pageMap = new Map<string, AiVisibilityPage>();
      const ensurePage = (rawPath: string): AiVisibilityPage => {
         const path = cleanPath(rawPath) || '/';
         let page = pageMap.get(path);
         if (!page) {
            page = {
               path,
               isCrawled: false,
               isCited: false,
               status: 'ai-invisible',
               aiCrawlHits: 0,
               aiReferralVisitors: 0,
               crawledBy: [],
               referredBy: [],
            };
            pageMap.set(path, page);
         }
         return page;
      };

      // 3a. Fold crawler hits into pages and a per-engine crawl tally.
      const engineMap = new Map<string, AiVisibilityEngine>();
      const ensureEngine = (engine: string, owner: string | null): AiVisibilityEngine => {
         let row = engineMap.get(engine);
         if (!row) {
            row = { engine, owner, status: 'absent', crawls: 0, crawledPages: [], referrals: 0, referredPages: [] };
            engineMap.set(engine, row);
         }
         if (!row.owner && owner) { row.owner = owner; }
         return row;
      };

      aiCrawlerRows.forEach((row) => {
         const page = ensurePage(row.path);
         page.isCrawled = true;
         page.aiCrawlHits += 1;
         const existingBot = page.crawledBy.find((b) => b.bot === row.bot);
         if (existingBot) {
            existingBot.hits += 1;
            if (row.hitAt > existingBot.lastSeen) { existingBot.lastSeen = row.hitAt; }
         } else {
            page.crawledBy.push({ bot: row.bot, owner: row.owner, hits: 1, lastSeen: row.hitAt });
         }
         const engineLabel = OWNER_TO_ENGINE[row.owner || ''] || row.owner || row.bot;
         const engine = ensureEngine(engineLabel, row.owner);
         engine.crawls += 1;
         if (!engine.crawledPages.includes(page.path)) { engine.crawledPages.push(page.path); }
      });

      // 3b. Fold AI referrals into per-engine referral tallies, and into pages
      //     when (and only when) the provider exposes a landing path.
      aiReferralSources.forEach((s) => {
         const engineLabel = s.engine || s.name || 'Unknown AI';
         const visitors = Number(s.unique_visitors ?? 0);
         const engine = ensureEngine(engineLabel, null);
         engine.referrals += visitors;
         if (s.landing_path) {
            const page = ensurePage(s.landing_path);
            page.isCited = true;
            page.aiReferralVisitors += visitors;
            const existingRef = page.referredBy.find((r) => r.engine === engineLabel);
            if (existingRef) { existingRef.visitors += visitors; } else { page.referredBy.push({ engine: engineLabel, visitors }); }
            if (!engine.referredPages.includes(page.path)) { engine.referredPages.push(page.path); }
         }
      });

      // 4. Resolve per-page status from the crawl/cite cross.
      const pageStatusFor = (page: AiVisibilityPage): PageStatus => {
         if (page.isCrawled && page.isCited) { return 'ai-visible'; }
         if (page.isCrawled) { return 'crawled-not-cited'; }
         if (page.isCited) { return 'cited-not-crawled'; }
         return 'ai-invisible';
      };
      const pages = Array.from(pageMap.values()).map((page) => ({
         ...page,
         status: pageStatusFor(page),
         crawledBy: page.crawledBy.slice().sort((a, b) => b.hits - a.hits),
         referredBy: page.referredBy.slice().sort((a, b) => b.visitors - a.visitors),
      }));
      pages.sort((a, b) => (b.aiCrawlHits + b.aiReferralVisitors) - (a.aiCrawlHits + a.aiReferralVisitors));

      // 5. Resolve per-engine status. An engine that refers traffic is an
      //    advocate even if no crawl was recorded in the window.
      const engineStatusFor = (engine: AiVisibilityEngine): EngineStatus => {
         if (engine.referrals > 0) { return 'advocate'; }
         if (engine.crawls > 0) { return 'aware-not-recommending'; }
         return 'absent';
      };
      const engines = Array.from(engineMap.values()).map((engine) => ({
         ...engine,
         status: engineStatusFor(engine),
      }));
      engines.sort((a, b) => (b.crawls + b.referrals) - (a.crawls + a.referrals));

      // 6. Funnel summary.
      const totalAICrawls = aiCrawlerRows.length;
      const totalAIReferrals = aiReferralSources.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
      const crawledPagesCount = pages.filter((p) => p.isCrawled).length;
      const crawledAndCitedCount = pages.filter((p) => p.isCrawled && p.isCited).length;
      const crawlToReferralRate = crawledPagesCount > 0
         ? Math.round((crawledAndCitedCount / crawledPagesCount) * 1000) / 10
         : 0;

      const advocates = engines.filter((e) => e.status === 'advocate');
      const topAdvocate = advocates.length > 0
         ? advocates.slice().sort((a, b) => b.referrals - a.referrals)[0].engine
         : null;

      let biggestGap: FunnelSummary['biggestGap'] = null;
      engines.forEach((e) => {
         const gap = e.crawls - e.referrals;
         if (gap > 0 && (!biggestGap || gap > biggestGap.gap)) {
            biggestGap = { engine: e.engine, crawls: e.crawls, referrals: e.referrals, gap };
         }
      });

      const summary: FunnelSummary = {
         totalAICrawls,
         totalAIReferrals,
         crawlToReferralRate,
         topAdvocate,
         biggestGap,
      };

      // 7. Optional enrichment: when first-party AI behavior is thin (few/no AI
      //    crawls AND no AI referrals), score the top pages' AI-readiness so the
      //    funnel still says something useful. Never let the audit break the route.
      const dataIsThin = totalAICrawls < 10 && totalAIReferrals === 0;
      let citabilityAudit: CitabilityAudit | null = null;
      if (dataIsThin) {
         try {
            // Seed the audit with whatever pages we know about (crawled/cited),
            // plus the root. auditCitability dedupes and caps the set itself.
            const knownPaths = pages.map((p) => p.path);
            citabilityAudit = await auditCitability(domain, knownPaths);
         } catch (auditErr) {
            citabilityAudit = null;
            console.log('[WARN] Citability audit failed for ', domain, auditErr);
         }
      }

      let note: string | null = null;
      if (dataIsThin) {
         note = 'First-party AI crawl/referral data is thin for this window, so the funnel is mostly empty. The '
            + 'citabilityAudit shows how AI-ready the top pages are (a leading indicator), and AI crawls typically '
            + 'appear before AI referrals do. Re-check as the window fills.';
      } else if (!referralLandingAvailable) {
         note = 'AI referrals are reported site-wide by this analytics provider (no per-landing-page detail), so '
            + 'per-page citation cannot be attributed: pages show isCited=false even when the site overall is '
            + 'cited. Engine-level referrals and the funnel totals are still accurate. Use ai_referrals for '
            + 'site-wide AI-engine totals.';
      }

      return res.status(200).json({
         domain,
         period,
         engines,
         pages,
         summary,
         dataIsThin,
         citabilityAudit,
         crawlerError,
         referralError,
         referralLandingAvailable,
         note,
      });
   } catch (error) {
      console.log('[ERROR] Building AI Visibility funnel for ', domain, error);
      return res.status(400).json({ error: 'Error Building AI Visibility funnel for this Domain.' });
   }
};
