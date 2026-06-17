import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import { fetchDomainSCData, getSearchConsoleApiInfo, readLocalSCData } from '../../utils/searchConsole';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import resolveDomainAccess from '../../utils/domain-access';
import type Account from '../../database/models/account';

type searchConsoleRes = {
   data: SCDomainDataType|null
   error?: string|null,
}

type searchConsoleCRONRes = {
   status: string,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomainSearchConsoleData(req, res, account);
   }
   if (req.method === 'POST') {
      return cronRefreshSearchConsoleData(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const getDomainSearchConsoleData = async (req: NextApiRequest, res: NextApiResponse<searchConsoleRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') return res.status(400).json({ data: null, error: 'Domain is Missing.' });
   const domainname = (req.query.domain as string).replaceAll('-', '.').replaceAll('_', '-');
   const foundDomain:Domain| null = await resolveDomainAccess(account, domainname);
   if (!foundDomain) {
      return res.status(403).json({ data: null, error: 'Domain not found for this account' });
   }
   const localSCData = await readLocalSCData(domainname);
   if (localSCData && localSCData.thirtyDays && localSCData.thirtyDays.length) {
      return res.status(200).json({ data: localSCData });
   }
   try {
      const domainObj: DomainType = foundDomain.get({ plain: true });
      const scDomainAPI = await getSearchConsoleApiInfo(domainObj);
      if (!(scDomainAPI.client_email && scDomainAPI.private_key)) {
         return res.status(200).json({ data: null, error: 'Google Search Console is not Integrated.' });
      }
      const scData = await fetchDomainSCData(domainObj, scDomainAPI);
      return res.status(200).json({ data: scData });
   } catch (error) {
      console.log('[ERROR] Getting Search Console Data for: ', domainname, error);
      return res.status(400).json({ data: null, error: 'Error Fetching Data from Google Search Console.' });
   }
};

const cronRefreshSearchConsoleData = async (req: NextApiRequest, res: NextApiResponse<searchConsoleCRONRes>, account?: Account | null) => {
   try {
      const allDomainsRaw = await Domain.findAll({ where: { ...scopeWhere(account) } });
      const Domains: DomainType[] = allDomainsRaw.map((el) => el.get({ plain: true }));
      for (const domain of Domains) {
         const scDomainAPI = await getSearchConsoleApiInfo(domain);
         if (scDomainAPI.client_email && scDomainAPI.private_key) {
            await fetchDomainSCData(domain, scDomainAPI);
         }
      }
      return res.status(200).json({ status: 'completed' });
   } catch (error) {
      console.log('[ERROR] CRON Updating Search Console Data. ', error);
      return res.status(400).json({ status: 'failed', error: 'Error Fetching Data from Google Search Console.' });
   }
};
