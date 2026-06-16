import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import Domain from '../../database/models/domain';
import { getAnalyticsProvider } from '../../utils/analytics';
import { estimateHumanTraffic, HumanTrafficEstimate } from '../../utils/bot-filter';

type HumanTrafficResponse = {
   domain?: string,
   period?: string,
   estimate?: Omit<HumanTrafficEstimate, 'error'>,
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<HumanTrafficResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getHumanTraffic(req, res, account);
}

const getHumanTraffic = async (req: NextApiRequest, res: NextApiResponse<HumanTrafficResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      const { error, ...estimate } = await estimateHumanTraffic(getAnalyticsProvider(), domain, period);
      return res.status(200).json({ domain, period, estimate, error });
   } catch (error) {
      console.log('[ERROR] Estimating Human Traffic for ', domain, error);
      return res.status(400).json({ error: 'Error Estimating Human Traffic for this Domain.' });
   }
};
