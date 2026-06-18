import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
import { getAppSettings } from './settings';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import type Account from '../../database/models/account';
import refreshAndUpdateKeywords from '../../utils/refresh';

type CRONRefreshRes = {
   started: boolean
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'POST') {
      return cronRefreshkeywords(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const cronRefreshkeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = scopeWhere(account);
      await Keyword.update({ updating: true }, { where: { ...scope } });
      const keywordQueries: Keyword[] = await Keyword.findAll({ where: { ...scope } });
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      refreshAndUpdateKeywords(keywordQueries, settings, domainList);

      return res.status(200).json({ started: true });
   } catch (error) {
      console.log('[ERROR] CRON Refreshing Keywords: ', error);
      return res.status(400).json({ started: false, error: 'CRON Error refreshing keywords!' });
   }
};
