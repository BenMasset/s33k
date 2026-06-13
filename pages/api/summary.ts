import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import verifyUser from '../../utils/verifyUser';
import { getAnalyticsProvider, SummaryResult } from '../../utils/analytics';

type SummaryResponse = {
   domain?: string,
   period?: string,
   summary?: Omit<SummaryResult, 'error'>,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<SummaryResponse>) {
   await db.sync();
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getSummary(req, res);
}

const getSummary = async (req: NextApiRequest, res: NextApiResponse<SummaryResponse>) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      const { error, ...summary } = await getAnalyticsProvider().getSummary(domain, period);
      return res.status(200).json({ domain, period, summary, error });
   } catch (error) {
      console.log('[ERROR] Building Summary for ', domain, error);
      return res.status(400).json({ error: 'Error Building Summary for this Domain.' });
   }
};
