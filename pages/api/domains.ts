import type { NextApiRequest, NextApiResponse } from 'next';
import Cryptr from 'cryptr';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import getdomainStats from '../../utils/domains';
import authorize from '../../utils/authorize';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import type Account from '../../database/models/account';
import { checkSerchConsoleIntegration, removeLocalSCData } from '../../utils/searchConsole';
import { removeFromRetryQueue } from '../../utils/scraper';

type DomainsGetRes = {
   domains: DomainType[]
   error?: string|null,
}

type DomainsAddResponse = {
   domains: DomainType[]|null,
   error?: string|null,
}

type DomainsDeleteRes = {
   domainRemoved: number,
   keywordsRemoved: number,
   SCDataRemoved: boolean,
   error?: string|null,
}

type DomainsUpdateRes = {
   domain: Domain|null,
   error?: string|null,
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'GET') {
      return getDomains(req, res, account);
   }
   if (req.method === 'POST') {
      return addDomain(req, res, account);
   }
   if (req.method === 'DELETE') {
      return deleteDomain(req, res, account);
   }
   if (req.method === 'PUT') {
      return updateDomain(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

export const getDomains = async (req: NextApiRequest, res: NextApiResponse<DomainsGetRes>, account?: Account | null) => {
   const withStats = !!req?.query?.withstats;
   try {
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scopeWhere(account) } });
      const formattedDomains: DomainType[] = allDomains.map((el) => {
         const domainItem:DomainType = el.get({ plain: true });
         const scData = domainItem?.search_console ? JSON.parse(domainItem.search_console) : {};
         const { client_email, private_key } = scData;
         const searchConsoleData = scData ? { ...scData, client_email: client_email ? 'true' : '', private_key: private_key ? 'true' : '' } : {};
         return { ...domainItem, search_console: JSON.stringify(searchConsoleData) };
      });
      const theDomains: DomainType[] = withStats ? await getdomainStats(formattedDomains) : formattedDomains;
      return res.status(200).json({ domains: theDomains });
   } catch (error) {
      return res.status(400).json({ domains: [], error: 'Error Getting Domains.' });
   }
};

const addDomain = async (req: NextApiRequest, res: NextApiResponse<DomainsAddResponse>, account?: Account | null) => {
   const { domains } = req.body;
   if (domains && Array.isArray(domains) && domains.length > 0) {
      const domainsToAdd: any = [];
      const owner_id = ownerIdFor(account);

      domains.forEach((domain: string) => {
         domainsToAdd.push({
            domain: domain.trim(),
            slug: domain.trim().replaceAll('-', '_').replaceAll('.', '-').replaceAll('/', '-'),
            lastUpdated: new Date().toJSON(),
            added: new Date().toJSON(),
            owner_id,
         });
      });
      try {
         const newDomains:Domain[] = await Domain.bulkCreate(domainsToAdd);
         const formattedDomains = newDomains.map((el) => el.get({ plain: true }));
         return res.status(201).json({ domains: formattedDomains });
      } catch (error) {
         console.log('[ERROR] Adding New Domain ', error);
         return res.status(400).json({ domains: [], error: 'Error Adding Domain.' });
      }
   } else {
      return res.status(400).json({ domains: [], error: 'Necessary data missing.' });
   }
};

export const deleteDomain = async (req: NextApiRequest, res: NextApiResponse<DomainsDeleteRes>, account?: Account | null) => {
   if (!req.query.domain && typeof req.query.domain !== 'string') {
      return res.status(400).json({ domainRemoved: 0, keywordsRemoved: 0, SCDataRemoved: false, error: 'Domain is Required!' });
   }
   try {
      const { domain } = req.query || {};
      const scope = scopeWhere(account);
      // OWNERSHIP GATE (security review #5): confirm the caller actually owns a domain row
      // BEFORE touching anything, so a tenant cannot delete another tenant's keywords or
      // its on-disk Search Console cache by passing the bare domain string. With
      // MULTI_TENANT off, scopeWhere is {} so this is the existing "does the domain exist"
      // check; with it on, it enforces owner_id.
      const owned = await Domain.findOne({ where: { domain, ...scope } });
      if (!owned) {
         return res.status(404).json({ domainRemoved: 0, keywordsRemoved: 0, SCDataRemoved: false, error: 'Domain not found for this account' });
      }
      await Promise.all((await Keyword.findAll({ where: { domain, ...scope } })).map((keyword) => removeFromRetryQueue(keyword.ID)));
      const removedDomCount: number = await Domain.destroy({ where: { domain, ...scope } });
      const removedKeywordCount: number = await Keyword.destroy({ where: { domain, ...scope } });
      // Only clear the local Search Console cache once a scoped domain was actually removed.
      const SCDataRemoved = removedDomCount > 0 ? await removeLocalSCData(domain as string) : false;

      return res.status(200).json({ domainRemoved: removedDomCount, keywordsRemoved: removedKeywordCount, SCDataRemoved });
   } catch (error) {
      console.log('[ERROR] Deleting Domain: ', req.query.domain, error);
      return res.status(400).json({ domainRemoved: 0, keywordsRemoved: 0, SCDataRemoved: false, error: 'Error Deleting Domain' });
   }
};

export const updateDomain = async (req: NextApiRequest, res: NextApiResponse<DomainsUpdateRes>, account?: Account | null) => {
   if (!req.query.domain) {
      return res.status(400).json({ domain: null, error: 'Domain is Required!' });
   }
   const { domain } = req.query || {};
   const {
      notification_interval, notification_emails, search_console,
      scrape_strategy, scrape_pagination_limit, scrape_smart_full_fallback,
      subdomain_matching,
   } = req.body as DomainSettings;

   try {
      const domainToUpdate: Domain|null = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
      // Validate Search Console API Data
      if (domainToUpdate && search_console?.client_email && search_console?.private_key) {
         const theDomainObj = domainToUpdate.get({ plain: true });
         const isSearchConsoleAPIValid = await checkSerchConsoleIntegration({ ...theDomainObj, search_console: JSON.stringify(search_console) });
         if (!isSearchConsoleAPIValid.isValid) {
            return res.status(400).json({ domain: null, error: isSearchConsoleAPIValid.error });
         }
         const cryptr = new Cryptr(process.env.SECRET as string);
         search_console.client_email = search_console.client_email ? cryptr.encrypt(search_console.client_email.trim()) : '';
         search_console.private_key = search_console.private_key ? cryptr.encrypt(search_console.private_key.trim()) : '';
      }
      if (domainToUpdate) {
         domainToUpdate.set({
            notification_interval,
            notification_emails,
            search_console: JSON.stringify(search_console),
            scrape_strategy: scrape_strategy || '',
            scrape_pagination_limit: scrape_pagination_limit || 0,
            scrape_smart_full_fallback: !!scrape_smart_full_fallback,
            subdomain_matching: subdomain_matching || '',
         });
         await domainToUpdate.save();
      }
      return res.status(200).json({ domain: domainToUpdate });
   } catch (error) {
      console.log('[ERROR] Updating Domain: ', req.query.domain, error);
      return res.status(400).json({ domain: null, error: 'Error Updating Domain. An Unknown Error Occurred.' });
   }
};
