import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import verifyUser from '../../utils/verifyUser';
import { getAnalyticsProvider, BreakdownDimension, BreakdownRow } from '../../utils/analytics';

type BreakdownResponse = {
   domain?: string,
   period?: string,
   dimension?: string,
   rows?: BreakdownRow[],
   error?: string | null,
}

const VALID_DIMENSIONS: BreakdownDimension[] = [
   'country', 'region', 'city', 'device', 'browser', 'os', 'language', 'screen',
];

export default async function handler(req: NextApiRequest, res: NextApiResponse<BreakdownResponse>) {
   await db.sync();
   const authorized = verifyUser(req, res);
   if (authorized !== 'authorized') {
      return res.status(401).json({ error: authorized });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getBreakdown(req, res);
}

const getBreakdown = async (req: NextApiRequest, res: NextApiResponse<BreakdownResponse>) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const dimension = (typeof req.query.dimension === 'string' ? req.query.dimension : '') as BreakdownDimension;
   if (!VALID_DIMENSIONS.includes(dimension)) {
      return res.status(400).json({ error: `Invalid or missing dimension. Use one of: ${VALID_DIMENSIONS.join(', ')}.` });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      const { rows, error } = await getAnalyticsProvider().getBreakdown(domain, dimension, period);
      return res.status(200).json({ domain, period, dimension, rows, error });
   } catch (error) {
      console.log('[ERROR] Building Breakdown for ', domain, dimension, error);
      return res.status(400).json({ error: 'Error Building Breakdown for this Domain.' });
   }
};
