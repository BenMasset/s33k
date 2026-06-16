import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { cleanPath } from '../../utils/lodd';
import { getAnalyticsProvider, NormalizedPage, ReferralSource } from '../../utils/analytics';

type ScoreboardKeyword = {
   keyword: string,
   position: number,
   device: string,
   url: string,
}

type ScoreboardPage = {
   url: string,
   pathClean: string,
   page_title?: string,
   page_views: number,
   unique_visitors?: number,
   bounce_rate?: number | null,
   avg_duration?: number | null,
   metricsNote?: string,
   aiReferralVisitors: number,
   keywords: ScoreboardKeyword[],
}

type ContentGapPage = {
   url: string,
   pathClean: string,
   page_title?: string,
   page_views: number,
   unique_visitors?: number,
   bounce_rate?: number | null,
   avg_duration?: number | null,
   metricsNote?: string,
   aiReferralVisitors: number,
}

type UnmatchedKeyword = ScoreboardKeyword & { target_page: string }

type ScoreboardResponse = {
   domain?: string,
   period?: string,
   scoreboard?: ScoreboardPage[],
   pagesWithTrafficNoKeywords?: ContentGapPage[],
   keywordsWithNoMatchingPage?: UnmatchedKeyword[],
   analyticsError?: string | null,
   referralError?: string | null,
   aiReferralNote?: string | null,
   loddError?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ScoreboardResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getScoreboard(req, res, account);
}

const getScoreboard = async (req: NextApiRequest, res: NextApiResponse<ScoreboardResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   // Verify the caller owns this domain before exposing any of its data. With MULTI_TENANT
   // off, scopeWhere returns {} so this matches the domain by name exactly as before.
   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      // 1. Load this domain's keywords from the DB (same path as keywords.ts getKeywords).
      const allKeywords: Keyword[] = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
      const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));

      // 2. Fetch per-page traffic from the configured analytics provider.
      const provider = getAnalyticsProvider();
      const { pages: trafficPages, error: analyticsError } = await provider.getPageTraffic(domain, period);

      // 2b. Fetch AI-referral sources so we can attribute AI-referred visitors to
      // a landing page when the provider exposes a per-landing-page detail. Most
      // providers report referrals only site-wide (no landing_path), in which
      // case per-page AI attribution is unavailable and we surface 0 with a note
      // rather than guessing. Never let a referral failure break the scoreboard.
      let aiVisitorsByLanding = new Map<string, number>();
      let referralError: string | null = null;
      let aiReferralLandingAvailable = false;
      try {
         const { sources, error: refError } = await provider.getReferralSources(domain, period);
         referralError = refError;
         const aiSources = (sources || []).filter((s: ReferralSource) => s.isAI);
         aiSources.forEach((s) => {
            if (s.landing_path) {
               aiReferralLandingAvailable = true;
               const key = cleanPath(s.landing_path);
               const visitors = Number(s.unique_visitors ?? 0);
               aiVisitorsByLanding.set(key, (aiVisitorsByLanding.get(key) || 0) + visitors);
            }
         });
      } catch (refErr) {
         referralError = refErr instanceof Error ? refErr.message : String(refErr);
         aiVisitorsByLanding = new Map<string, number>();
      }
      const aiReferralNote = aiReferralLandingAvailable
         ? null
         : 'AI-referral data has no per-landing-page detail from this provider, so aiReferralVisitors '
            + 'is 0 (n/a) on every page. Use the ai_referrals tool for site-wide AI-engine totals.';

      // 3. Build a lookup of traffic pages by clean path.
      const pageByPath = new Map<string, NormalizedPage>();
      trafficPages.forEach((page) => { pageByPath.set(page.pathClean, page); });

      // 4. Group keywords by their normalized target_page path.
      const keywordsByPath = new Map<string, ScoreboardKeyword[]>();
      const keywordsWithNoMatchingPage: UnmatchedKeyword[] = [];

      keywords.forEach((kw) => {
         const targetPage = kw.target_page || '';
         const targetClean = cleanPath(targetPage);
         const scoreboardKw: ScoreboardKeyword = {
            keyword: kw.keyword,
            position: kw.position,
            device: kw.device,
            url: kw.url,
         };
         // A keyword matches a page when its normalized target_page equals the page pathClean.
         if (targetClean && pageByPath.has(targetClean)) {
            const list = keywordsByPath.get(targetClean) || [];
            list.push(scoreboardKw);
            keywordsByPath.set(targetClean, list);
         } else {
            // No Lodd page matched: surface it so nothing is silently dropped.
            keywordsWithNoMatchingPage.push({ ...scoreboardKw, target_page: targetPage });
         }
      });

      // 5. Build the per-page scoreboard for pages that have at least one matched keyword.
      const scoreboard: ScoreboardPage[] = [];
      const pagesWithTrafficNoKeywords: ContentGapPage[] = [];

      trafficPages.forEach((page) => {
         const matched = keywordsByPath.get(page.pathClean) || [];
         const aiReferralVisitors = aiVisitorsByLanding.get(page.pathClean) || 0;
         if (matched.length > 0) {
            scoreboard.push({
               url: page.url,
               pathClean: page.pathClean,
               page_title: page.page_title,
               page_views: page.page_views,
               unique_visitors: page.unique_visitors,
               bounce_rate: page.bounce_rate,
               avg_duration: page.avg_duration,
               metricsNote: page.metricsNote,
               aiReferralVisitors,
               keywords: matched,
            });
         } else {
            // Content-gap signal: this page gets traffic but has no tracked keyword.
            pagesWithTrafficNoKeywords.push({
               url: page.url,
               pathClean: page.pathClean,
               page_title: page.page_title,
               page_views: page.page_views,
               unique_visitors: page.unique_visitors,
               bounce_rate: page.bounce_rate,
               avg_duration: page.avg_duration,
               metricsNote: page.metricsNote,
               aiReferralVisitors,
            });
         }
      });

      // Sort by page_views desc.
      scoreboard.sort((a, b) => b.page_views - a.page_views);
      pagesWithTrafficNoKeywords.sort((a, b) => b.page_views - a.page_views);

      return res.status(200).json({
         domain,
         period,
         scoreboard,
         pagesWithTrafficNoKeywords,
         keywordsWithNoMatchingPage,
         analyticsError,
         referralError,
         aiReferralNote,
         // Back-compat alias: existing UI/MCP consumers may still read loddError.
         loddError: analyticsError,
      });
   } catch (error) {
      console.log('[ERROR] Building Scoreboard for ', domain, error);
      return res.status(400).json({ error: 'Error Building Scoreboard for this Domain.' });
   }
};
