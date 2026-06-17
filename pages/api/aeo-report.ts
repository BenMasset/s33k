import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import CrawlerHit from '../../database/models/crawlerHit';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, ReferralSource } from '../../utils/analytics';
import { periodStartMs } from '../../utils/period';

/*
 * ============================================================================
 * s33k TRUST MARKER: NO MODEL TRAINING. NO LLM CALL.
 * ============================================================================
 * This route NEVER queries an LLM, NEVER embeds/fine-tunes, and NEVER transmits
 * account data to any external model. It only reads first-party, un-gameable
 * signals s33k already records (AI referral traffic from the analytics provider,
 * AI crawler hits from the CrawlerHit model) and bundles them. Narration happens
 * in the USER's own LLM over MCP. Full trust documentation: SECURITY.md (and the
 * security_facts MCP tool).
 * ============================================================================
 */

/**
 * aeo_report: a single-call AEO (AI-search) snapshot for one domain.
 *
 * GET /api/aeo-report?domain=getmasset.com&period=30d
 *
 * A PREBUILT REPORT bundles existing AEO signals into one sectioned response the
 * user's LLM narrates, so a marketer gets the whole AI-search picture in one call
 * instead of stitching ai_referrals + ai_crawlers + ai_visibility by hand. It
 * does NOT call those API routes over HTTP: it reuses the SAME utils and queries
 * the SAME models the AEO endpoints use, so the numbers match by construction.
 *
 * Sections:
 *   aiReferrals    Which AI engines actually SENT visitors, per engine, with
 *                  counts. Mirrors pages/api/ai-referrals.ts: classifyReferrer
 *                  has already run inside the provider (ReferralSource.isAI /
 *                  .engine), so we filter to AI and aggregate by engine label.
 *   aiCrawlers     Which AI bots HIT the site in the window, per bot. Mirrors
 *                  pages/api/ai-crawlers.ts: reads CrawlerHit rows for the window
 *                  and aggregates per bot.
 *   funnelSummary  The leading-indicator-to-outcome view (like ai-visibility):
 *                  per engine, crawls vs referrals, joined on one engine name via
 *                  OWNER_TO_ENGINE, plus the top advocate and the biggest gap.
 *
 * When first-party AEO data is thin (few/no AI crawls AND no AI referrals), the
 * `note` says so honestly, because AI crawls normally appear before AI referrals,
 * so an empty-but-early funnel is the expected state, not a bug.
 *
 * Wired-route contract: db.sync, authorize -> 401, GET guard -> 405, Domain
 * ownership scopeWhere -> 403, try/catch -> 400. Degrades gracefully: a thrown
 * crawler read or referral read sets the matching error field and still returns
 * 200 with the rest of the report intact.
 */

/** Per-engine AI referral row (the outcome: AI engines that sent visitors). */
type AiReferralRow = {
   engine: string,
   visitors: number,
   pageViews: number,
}

/** Per-bot AI crawler row (the leading indicator: AI bots that hit the site). */
type AiCrawlerRow = {
   bot: string,
   owner: string | null,
   hits: number,
   lastSeen: string,
}

/** Per-engine funnel row joining the crawl side and the referral side on one name. */
type FunnelEngineRow = {
   engine: string,
   owner: string | null,
   /** advocate = crawls AND refers; aware = crawls, no referrals; absent = neither. */
   status: 'advocate' | 'aware-not-recommending' | 'absent',
   crawls: number,
   referrals: number,
}

type FunnelSummary = {
   totalAICrawls: number,
   totalAIReferrals: number,
   /** The engine doing the most for you (advocate with the most referrals), or null. */
   topAdvocate: string | null,
   /** The engine most aware (crawling) but least citing (largest crawl-minus-referral gap). */
   biggestGap: { engine: string, crawls: number, referrals: number, gap: number } | null,
   engines: FunnelEngineRow[],
}

type AeoReportResponse = {
   domain?: string,
   period?: string,
   aiReferrals?: {
      byEngine: AiReferralRow[],
      totals: { aiVisitors: number, allReferredVisitors: number, aiSharePct: number },
   },
   aiCrawlers?: {
      byBot: AiCrawlerRow[],
      totals: { aiEngineHits: number, allCrawlerHits: number },
   },
   funnelSummary?: FunnelSummary,
   // Non-fatal sub-signal errors, surfaced so a partial report is honest.
   referralError?: string | null,
   crawlerError?: string | null,
   note?: string | null,
   error?: string | null,
}

/** A normalized crawler hit row pulled from the DB (raw: true). */
type CrawlerRow = {
   bot: string,
   owner: string | null,
   isAiEngine: boolean,
   path: string,
   userAgent: string,
   hitAt: string,
}

/*
 * Map a crawler owner label (the classifier on the crawl side keys by owner:
 * Google, OpenAI, ...) to the referral engine label (the classifier on the
 * referral side keys by engine: Gemini, ChatGPT, ...) so the two halves of the
 * funnel join on ONE engine name. Mirrors pages/api/ai-visibility.ts so the
 * report's funnel agrees with the standalone ai_visibility tool. Falls back to
 * the owner when there is no distinct referral name.
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

export default async function handler(req: NextApiRequest, res: NextApiResponse<AeoReportResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAeoReport(req, res, account);
}

const getAeoReport = async (req: NextApiRequest, res: NextApiResponse<AeoReportResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // Verify the caller owns this domain before exposing any of its data. With
      // MULTI_TENANT off, scopeWhere is {} so this matches the domain by name.
      const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      // --- Section 1: AI REFERRALS (the outcome). Same read as ai-referrals.ts.
      // The provider has already run classifyReferrer, so ReferralSource carries
      // isAI and the normalized engine label. We keep AI sources and aggregate by
      // engine. A thrown provider read degrades to an empty section + error field.
      let referralError: string | null = null;
      let aiReferralSources: ReferralSource[] = [];
      let allReferredVisitors = 0;
      try {
         const { sources, error: refError } = await getAnalyticsProvider().getReferralSources(domain, period);
         referralError = refError;
         const all = sources || [];
         allReferredVisitors = all.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
         aiReferralSources = all.filter((s) => s.isAI);
      } catch (refErr) {
         referralError = refErr instanceof Error ? refErr.message : String(refErr);
      }

      const referralEngineMap = new Map<string, AiReferralRow>();
      aiReferralSources.forEach((s) => {
         const engine = s.engine || s.name || 'Unknown AI';
         const existing = referralEngineMap.get(engine) || { engine, visitors: 0, pageViews: 0 };
         existing.visitors += Number(s.unique_visitors ?? 0);
         existing.pageViews += Number(s.page_views ?? 0);
         referralEngineMap.set(engine, existing);
      });
      const referralByEngine = Array.from(referralEngineMap.values()).sort((a, b) => b.visitors - a.visitors);
      const aiVisitors = referralByEngine.reduce((sum, r) => sum + r.visitors, 0);
      const aiSharePct = allReferredVisitors > 0 ? Math.round((aiVisitors / allReferredVisitors) * 1000) / 10 : 0;

      // --- Section 2: AI CRAWLERS (the leading indicator). Same read as
      // ai-crawlers.ts: CrawlerHit rows in the window, aggregated per bot.
      // periodStartMs gives the cutoff so the crawl window matches the traffic
      // window. A thrown crawler read degrades to an empty section + error field.
      let crawlerError: string | null = null;
      let crawlerRows: CrawlerRow[] = [];
      try {
         const cutoff = new Date(periodStartMs(period, Date.now())).toJSON();
         crawlerRows = await CrawlerHit.findAll({
            where: { domain, hitAt: { [Op.gte]: cutoff } },
            order: [['hitAt', 'DESC']],
            raw: true,
         }) as unknown as CrawlerRow[];
      } catch (crawlErr) {
         crawlerError = crawlErr instanceof Error ? crawlErr.message : String(crawlErr);
      }
      const aiCrawlerRows = crawlerRows.filter((r) => r.isAiEngine);

      const crawlerBotMap = new Map<string, AiCrawlerRow>();
      aiCrawlerRows.forEach((row) => {
         const existing = crawlerBotMap.get(row.bot);
         if (existing) {
            existing.hits += 1;
            if (row.hitAt > existing.lastSeen) { existing.lastSeen = row.hitAt; }
         } else {
            crawlerBotMap.set(row.bot, { bot: row.bot, owner: row.owner, hits: 1, lastSeen: row.hitAt });
         }
      });
      const crawlerByBot = Array.from(crawlerBotMap.values()).sort((a, b) => b.hits - a.hits);

      // --- Section 3: FUNNEL SUMMARY (leading indicator vs outcome, per engine).
      // Join the crawl side (owner mapped to engine via OWNER_TO_ENGINE) and the
      // referral side (already engine-keyed) into one row per engine. This is the
      // ai-visibility synthesis, scoped to engine level for a one-glance summary.
      const funnelMap = new Map<string, FunnelEngineRow>();
      const ensureFunnelEngine = (engine: string, owner: string | null): FunnelEngineRow => {
         let row = funnelMap.get(engine);
         if (!row) {
            row = { engine, owner, status: 'absent', crawls: 0, referrals: 0 };
            funnelMap.set(engine, row);
         }
         if (!row.owner && owner) { row.owner = owner; }
         return row;
      };
      aiCrawlerRows.forEach((row) => {
         const engineLabel = OWNER_TO_ENGINE[row.owner || ''] || row.owner || row.bot;
         ensureFunnelEngine(engineLabel, row.owner).crawls += 1;
      });
      referralByEngine.forEach((r) => { ensureFunnelEngine(r.engine, null).referrals += r.visitors; });

      // An engine that refers traffic is an advocate even with no crawl recorded
      // in the window (the crawl can predate it); crawling-without-referring is
      // "aware but not recommending yet"; neither is "absent".
      const engines = Array.from(funnelMap.values()).map((e) => {
         let status: FunnelEngineRow['status'] = 'absent';
         if (e.referrals > 0) { status = 'advocate'; } else if (e.crawls > 0) { status = 'aware-not-recommending'; }
         return { ...e, status };
      });
      engines.sort((a, b) => (b.crawls + b.referrals) - (a.crawls + a.referrals));

      const totalAICrawls = aiCrawlerRows.length;
      const totalAIReferrals = aiVisitors;

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

      const funnelSummary: FunnelSummary = { totalAICrawls, totalAIReferrals, topAdvocate, biggestGap, engines };

      // Honest note when first-party AEO data is thin. AI crawls normally appear
      // before AI referrals, so an empty-but-early funnel is expected, not a bug.
      let note: string | null = null;
      if (totalAICrawls === 0 && totalAIReferrals === 0) {
         note = 'First-party AEO data is thin for this window: no AI crawler hits and no AI referral traffic recorded. '
            + 'AI crawls typically appear before AI referrals do, so an empty funnel early on is expected. Confirm AI '
            + 'bots are allowed (robots.txt, llms.txt) and re-check as the window fills.';
      } else if (totalAIReferrals === 0 && totalAICrawls > 0) {
         note = 'AI bots are crawling but no AI engine has sent visitors yet this window. That is the normal early state: '
            + 'crawl is the leading indicator, referrals are the outcome. The gap is citation, not access.';
      }

      return res.status(200).json({
         domain,
         period,
         aiReferrals: {
            byEngine: referralByEngine,
            totals: { aiVisitors, allReferredVisitors, aiSharePct },
         },
         aiCrawlers: {
            byBot: crawlerByBot,
            totals: { aiEngineHits: aiCrawlerRows.length, allCrawlerHits: crawlerRows.length },
         },
         funnelSummary,
         referralError,
         crawlerError,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building AEO Report for ', domain, error);
      return res.status(400).json({ error: 'Error Building AEO Report for this Domain.' });
   }
};
