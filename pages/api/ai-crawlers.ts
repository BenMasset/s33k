import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import CrawlerHit from '../../database/models/crawlerHit';
import type Account from '../../database/models/account';

type ByBotRow = {
   bot: string,
   owner: string | null,
   isAiEngine: boolean,
   hits: number,
   lastSeen: string,
}

type SampleRow = {
   bot: string,
   owner: string | null,
   isAiEngine: boolean,
   path: string,
   userAgent: string,
   hitAt: string,
}

type AiCrawlersResponse = {
   domain?: string,
   period?: string,
   byBot?: ByBotRow[],
   totals?: {
      aiEngineHits: number,
      allCrawlerHits: number,
   },
   recent?: SampleRow[],
   error?: string | null,
}

/**
 * Convert a period string (e.g. "30d", "7d", "12h", "4w", "3m") into a cutoff
 * Date. Anything unparseable defaults to a 30-day window. Mirrors the period
 * parsing the analytics providers use, so crawler windows match traffic windows.
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

export default async function handler(req: NextApiRequest, res: NextApiResponse<AiCrawlersResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getAiCrawlers(req, res, account);
}

const getAiCrawlers = async (req: NextApiRequest, res: NextApiResponse<AiCrawlersResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      const owned = await resolveDomainAccess(account, domain);
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      const cutoff = periodToCutoff(period).toJSON();
      const rows = await CrawlerHit.findAll({
         // CrawlerHit has NO owner_id column, so do NOT spread scopeWhere here (it would
         // filter a non-existent owner_id and break under MULTI_TENANT on Postgres). Isolation
         // comes from the resolveDomainAccess gate above plus the globally-@Unique domain: a
         // domain name belongs to exactly one account, so this read cannot cross tenants.
         where: { domain, hitAt: { [Op.gte]: cutoff } },
         order: [['hitAt', 'DESC']],
         raw: true,
      }) as unknown as Array<{
         bot: string,
         owner: string | null,
         isAiEngine: boolean,
         path: string,
         userAgent: string,
         hitAt: string,
      }>;

      // Aggregate per bot: hit count and most-recent sighting.
      const botMap = new Map<string, ByBotRow>();
      let aiEngineHits = 0;
      rows.forEach((row) => {
         if (row.isAiEngine) { aiEngineHits += 1; }
         const existing = botMap.get(row.bot);
         if (existing) {
            existing.hits += 1;
            if (row.hitAt > existing.lastSeen) { existing.lastSeen = row.hitAt; }
         } else {
            botMap.set(row.bot, {
               bot: row.bot,
               owner: row.owner,
               isAiEngine: row.isAiEngine,
               hits: 1,
               lastSeen: row.hitAt,
            });
         }
      });
      const byBot = Array.from(botMap.values()).sort((a, b) => b.hits - a.hits);

      const recent: SampleRow[] = rows.slice(0, 20).map((row) => ({
         bot: row.bot,
         owner: row.owner,
         isAiEngine: row.isAiEngine,
         path: row.path,
         userAgent: row.userAgent,
         hitAt: row.hitAt,
      }));

      return res.status(200).json({
         domain,
         period,
         byBot,
         totals: { aiEngineHits, allCrawlerHits: rows.length },
         recent,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building AI Crawlers report for ', domain, error);
      return res.status(400).json({ error: 'Error Building AI Crawlers report for this Domain.' });
   }
};
