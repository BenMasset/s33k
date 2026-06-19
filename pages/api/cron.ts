import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
import { getAppSettings } from './settings';
import authorize from '../../utils/authorize';
import { scopeWhere, isMultiTenantEnabled, ADMIN_ACCOUNT_ID } from '../../utils/scope';
import AccountModel from '../../database/models/account';
import type Account from '../../database/models/account';
import refreshAndUpdateKeywords from '../../utils/refresh';
import { isAccountActive } from '../../utils/plans';

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
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

// Build a map of owner_id -> isActive for the owners of the given keywords, so the cron spend-brake
// can drop keywords owned by an inactive (expired-trial / canceled / past_due) account. A keyword
// with a null owner_id is legacy/admin data and is always active (mapped under ADMIN_ACCOUNT_ID).
// One batched account read; never throws (a lookup failure leaves an owner absent, treated inactive
// by the caller's `=== true` check, which fails CLOSED, the safe direction for a spend brake).
const activeOwnerMap = async (keywords: Keyword[]): Promise<Map<number, boolean>> => {
   const active = new Map<number, boolean>();
   // The admin/legacy owner (null owner_id) is always active.
   active.set(ADMIN_ACCOUNT_ID, true);
   const ownerIds = Array.from(new Set(
      keywords
         .map((kw) => (kw.get('owner_id') as number | null))
         .filter((id): id is number => typeof id === 'number' && id !== ADMIN_ACCOUNT_ID),
   ));
   if (ownerIds.length === 0) { return active; }
   const accounts = await AccountModel.findAll({ where: { ID: ownerIds } });
   for (const acc of accounts) {
      active.set(acc.ID, isAccountActive(acc));
   }
   return active;
};

const cronRefreshkeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = scopeWhere(account);
      await Keyword.update({ updating: true }, { where: { ...scope } });
      let keywordQueries: Keyword[] = await Keyword.findAll({ where: { ...scope } });
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      // SPEND BRAKE (the cost protection): do NOT scrape keywords belonging to an INACTIVE account
      // (expired trial / canceled / past_due). Each scrape is a paid SERP call, so a lapsed account
      // must not keep burning the operator's Serper budget. This only applies with MULTI_TENANT on
      // AND the operator runs cron account-wide (scope {}); with the flag off there is one always-
      // active admin account and this filter is a no-op, so the single-tenant path is unchanged. We
      // resolve each keyword's owner account once and drop keywords whose owner is inactive.
      if (isMultiTenantEnabled() && Object.keys(scope).length === 0 && keywordQueries.length > 0) {
         const activeById = await activeOwnerMap(keywordQueries);
         keywordQueries = keywordQueries.filter((kw) => {
            const ownerId = (kw.get('owner_id') as number | null) ?? ADMIN_ACCOUNT_ID;
            return activeById.get(ownerId) === true;
         });
      }

      refreshAndUpdateKeywords(keywordQueries, settings, domainList);

      return res.status(200).json({ started: true });
   } catch (error) {
      console.log('[ERROR] CRON Refreshing Keywords: ', error);
      return res.status(400).json({ started: false, error: 'CRON Error refreshing keywords!' });
   }
};
