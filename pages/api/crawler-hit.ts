import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import CrawlerHit from '../../database/models/crawlerHit';
import type Account from '../../database/models/account';
import { classifyCrawler, CrawlerClassification } from '../../utils/ai-crawlers';

type CrawlerHitResponse = {
   recorded?: boolean,
   classification?: CrawlerClassification,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<CrawlerHitResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   return recordCrawlerHit(req, res, account);
}

const recordCrawlerHit = async (req: NextApiRequest, res: NextApiResponse<CrawlerHitResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   const path = typeof body.path === 'string' ? body.path : '';
   const userAgent = typeof body.userAgent === 'string' ? body.userAgent : '';

   if (!domain) {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   if (!userAgent) {
      return res.status(400).json({ error: 'userAgent is Required!' });
   }

   try {
      // A crawler hit is tenant data keyed by domain. Confirm the caller owns the domain
      // before recording, so one account cannot write hit rows against another's domain.
      // With MULTI_TENANT off, scopeWhere returns {} and this is the existing lookup-by-domain.
      const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
      if (!owned) {
         return res.status(403).json({ error: 'Domain not found for this account' });
      }

      const classification = classifyCrawler(userAgent);
      // Only persist a row when the user-agent is a recognized crawler. Normal
      // browser traffic is classified and reported back, but never stored.
      if (classification.isCrawler) {
         await CrawlerHit.create({
            domain,
            bot: classification.bot ?? '',
            owner: classification.owner ?? '',
            isAiEngine: classification.isAiEngine,
            path,
            userAgent,
            hitAt: new Date().toJSON(),
         });
      }
      return res.status(200).json({ recorded: classification.isCrawler, classification, error: null });
   } catch (error) {
      console.log('[ERROR] Recording Crawler Hit for ', domain, error);
      return res.status(400).json({ error: 'Error Recording Crawler Hit for this Domain.' });
   }
};
