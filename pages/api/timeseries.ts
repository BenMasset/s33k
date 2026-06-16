import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import { getAnalyticsProvider, TimeSeriesPoint } from '../../utils/analytics';

type TimeSeriesResponse = {
   domain?: string,
   period?: string,
   unit?: string,
   series?: TimeSeriesPoint[],
   error?: string | null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse<TimeSeriesResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getTimeSeries(req, res, account);
}

const getTimeSeries = async (req: NextApiRequest, res: NextApiResponse<TimeSeriesResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';
   const unit = (typeof req.query.unit === 'string' && req.query.unit) ? req.query.unit : 'day';

   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      const { series, error } = await getAnalyticsProvider().getTimeSeries(domain, period, unit);
      return res.status(200).json({ domain, period, unit, series, error });
   } catch (error) {
      console.log('[ERROR] Building TimeSeries for ', domain, error);
      return res.status(400).json({ error: 'Error Building TimeSeries for this Domain.' });
   }
};
