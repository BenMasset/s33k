import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import verifyUser from '../../utils/verifyUser';
import CrawlerHit from '../../database/models/crawlerHit';
import { classifyCrawler, CrawlerClassification } from '../../utils/ai-crawlers';

type CrawlerHitResponse = {
   recorded?: boolean,
   classification?: CrawlerClassification,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<CrawlerHitResponse>) {
   await db.sync();
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   return recordCrawlerHit(req, res);
}

const recordCrawlerHit = async (req: NextApiRequest, res: NextApiResponse<CrawlerHitResponse>) => {
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
