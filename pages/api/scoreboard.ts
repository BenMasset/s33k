import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Keyword from '../../database/models/keyword';
import verifyUser from '../../utils/verifyUser';
import parseKeywords from '../../utils/parseKeywords';
import getLoddPages, { cleanPath, LoddPage } from '../../utils/lodd';

type ScoreboardKeyword = {
   keyword: string,
   position: number,
   device: string,
   url: string,
}

type ScoreboardPage = {
   url: string,
   pathClean: string,
   page_title: string,
   page_views: number,
   unique_visitors: number,
   bounce_rate: number,
   avg_duration: number,
   keywords: ScoreboardKeyword[],
}

type ContentGapPage = {
   url: string,
   pathClean: string,
   page_title: string,
   page_views: number,
   unique_visitors: number,
   bounce_rate: number,
   avg_duration: number,
}

type UnmatchedKeyword = ScoreboardKeyword & { target_page: string }

type ScoreboardResponse = {
   domain?: string,
   period?: string,
   scoreboard?: ScoreboardPage[],
   pagesWithTrafficNoKeywords?: ContentGapPage[],
   keywordsWithNoMatchingPage?: UnmatchedKeyword[],
   loddError?: string | null,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<ScoreboardResponse>) {
   await db.sync();
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getScoreboard(req, res);
}

const getScoreboard = async (req: NextApiRequest, res: NextApiResponse<ScoreboardResponse>) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // 1. Load this domain's keywords from the DB (same path as keywords.ts getKeywords).
      const allKeywords: Keyword[] = await Keyword.findAll({ where: { domain } });
      const keywords: KeywordType[] = parseKeywords(allKeywords.map((e) => e.get({ plain: true })));

      // 2. Fetch Lodd per-page traffic.
      const { pages: loddPages, error: loddError } = await getLoddPages(period);

      // 3. Build a lookup of Lodd pages by clean path.
      const pageByPath = new Map<string, LoddPage>();
      loddPages.forEach((page) => { pageByPath.set(page.pathClean, page); });

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

      loddPages.forEach((page) => {
         const matched = keywordsByPath.get(page.pathClean) || [];
         if (matched.length > 0) {
            scoreboard.push({
               url: page.url,
               pathClean: page.pathClean,
               page_title: page.page_title,
               page_views: page.page_views,
               unique_visitors: page.unique_visitors,
               bounce_rate: page.bounce_rate,
               avg_duration: page.avg_duration,
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
         loddError,
      });
   } catch (error) {
      console.log('[ERROR] Building Scoreboard for ', domain, error);
      return res.status(400).json({ error: 'Error Building Scoreboard for this Domain.' });
   }
};
