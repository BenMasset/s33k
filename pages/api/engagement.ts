import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import verifyUser from '../../utils/verifyUser';
import { getAnalyticsProvider, EngagementTier } from '../../utils/analytics';

type EngagementResponse = {
   domain?: string,
   period?: string,
   tiers?: EngagementTier[],
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<EngagementResponse>) {
   await db.sync();
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getEngagement(req, res);
}

const getEngagement = async (req: NextApiRequest, res: NextApiResponse<EngagementResponse>) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      const { tiers, error } = await getAnalyticsProvider().getEngagement(domain, period);
      return res.status(200).json({ domain, period, tiers, error });
   } catch (error) {
      console.log('[ERROR] Building Engagement for ', domain, error);
      return res.status(400).json({ error: 'Error Building Engagement for this Domain.' });
   }
};
