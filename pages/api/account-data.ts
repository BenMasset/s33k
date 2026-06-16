import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import CrawlerHit from '../../database/models/crawlerHit';
import S33kEvent from '../../database/models/s33kEvent';
import Account from '../../database/models/account';
import ApiKey from '../../database/models/apiKey';
import authorize from '../../utils/authorize';
import { scopeWhere, ADMIN_ACCOUNT_ID } from '../../utils/scope';
import type Account2 from '../../database/models/account';
import { deleteUmamiWebsite } from '../../utils/umami-provision';

// HARD DELETE: the ultimate "your data is yours." DELETE /api/account-data permanently and
// irreversibly erases ALL of the calling account's data: every domain, every keyword (with
// rank history), every crawler hit, every autocapture event, the account's api_keys, and
// the account row itself, plus a best-effort deprovision of each per-domain Umami website.
//
// THIS IS SECURITY-CRITICAL AND IRREVERSIBLE. Three guardrails, all enforced here:
//   1. TENANT-SCOPED. Every delete is scoped with scopeWhere(account) (owner_id) and/or
//      restricted to the caller's OWN owned-domain names. A caller can NEVER delete another
//      account's anything. With MULTI_TENANT off the only caller is admin (refused, below).
//   2. CONFIRMATION-GATED. The body MUST contain { confirm: "DELETE" } or the route 400s
//      and deletes nothing. This makes an accidental or drive-by deletion impossible.
//   3. ADMIN REFUSED. If the resolved account is the admin/legacy account (ID ===
//      ADMIN_ACCOUNT_ID) the route 403s and deletes nothing. The admin account is the home
//      of all legacy single-tenant data and must never be erasable through this endpoint.
//
// The Umami sub-step is BEST-EFFORT and NEVER throws: deleteUmamiWebsite returns a result
// object on any failure, so an analytics-provider hiccup can never block (or partially
// abort) the user's deletion. The s33k DB rows are the source of truth.

type DeleteResponse = {
   deleted?: boolean,
   deletedAccountId?: number,
   domainsRemoved?: number,
   keywordsRemoved?: number,
   crawlerHitsRemoved?: number,
   eventsRemoved?: number,
   apiKeysRemoved?: number,
   accountRemoved?: boolean,
   umamiWebsitesDeleted?: number,
   warnings?: string[],
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<DeleteResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'DELETE') {
      return res.status(405).json({ error: 'Method Not Allowed. Use DELETE.' });
   }
   return deleteAccountData(req, res, account);
}

const deleteAccountData = async (req: NextApiRequest, res: NextApiResponse<DeleteResponse>, account?: Account2 | null) => {
   // GUARDRAIL 1 (confirmation gate). No exact { confirm: "DELETE" } -> 400, delete nothing.
   const confirm = req.body?.confirm;
   if (confirm !== 'DELETE') {
      return res.status(400).json({
         error: 'Confirmation required. Send { "confirm": "DELETE" } to permanently and irreversibly erase all of your account data.',
      });
   }

   // GUARDRAIL 2 (admin refused). The admin/legacy account holds all single-tenant data and
   // is never erasable here. account may be null only when MULTI_TENANT is off, which is the
   // admin path; treat that as the admin account and refuse.
   const accountId = account?.ID ?? ADMIN_ACCOUNT_ID;
   if (accountId === ADMIN_ACCOUNT_ID) {
      return res.status(403).json({ error: 'The admin account cannot be deleted through this endpoint.' });
   }

   const warnings: string[] = [];
   try {
      // GUARDRAIL 3 (tenant scope). Resolve the caller's OWN domains first; every subsequent
      // delete is bounded by scopeWhere(account) (owner_id) and/or this owned-domain set.
      const scope = scopeWhere(account);
      const domains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainNames = domains.map((d) => d.domain);

      // Best-effort Umami deprovision, BEFORE we drop the domain rows (we need the ids). Never
      // throws; a failure is logged as a warning and the account delete proceeds regardless.
      let umamiWebsitesDeleted = 0;
      const websiteIds = domains
         .map((d) => (d.umami_website_id ? String(d.umami_website_id).trim() : ''))
         .filter((id) => id !== '');
      for (const websiteId of websiteIds) {
         // eslint-disable-next-line no-await-in-loop
         const { deleted, error: umamiErr } = await deleteUmamiWebsite(websiteId);
         if (deleted) { umamiWebsitesDeleted += 1; } else if (umamiErr) { warnings.push(`Umami website ${websiteId}: ${umamiErr}`); }
      }

      // Delete the tenant's rows. Each delete is scoped: owner_id (keyword/event) AND/OR the
      // caller's owned-domain set (keyword/event/crawler_hit), and owner_id for the domains.
      const domainFilter = domainNames.length > 0 ? { [Op.in]: domainNames } : { [Op.in]: [] as string[] };

      const keywordsRemoved = await Keyword.destroy({ where: { ...scope, domain: domainFilter } });
      const eventsRemoved = await S33kEvent.destroy({ where: { ...scope, domain: domainFilter } });
      const crawlerHitsRemoved = domainNames.length > 0
         ? await CrawlerHit.destroy({ where: { domain: domainFilter } })
         : 0;
      const domainsRemoved = await Domain.destroy({ where: { ...scope } });

      // The account's API keys, then the account row. Scoped strictly to this account_id / ID,
      // never a wildcard, so no other account's keys or account row can be touched.
      const apiKeysRemoved = await ApiKey.destroy({ where: { account_id: accountId } });
      const accountDestroyed = await Account.destroy({ where: { ID: accountId } });
      const accountRemoved = accountDestroyed > 0;

      console.log(
         `[DELETE] Hard-deleted account ID ${accountId}: ${domainsRemoved} domains, ${keywordsRemoved} keywords, `
         + `${crawlerHitsRemoved} crawler hits, ${eventsRemoved} events, ${apiKeysRemoved} api keys, `
         + `account row removed: ${accountRemoved}, umami websites deleted: ${umamiWebsitesDeleted}. IRREVERSIBLE.`,
      );

      return res.status(200).json({
         deleted: true,
         deletedAccountId: accountId,
         domainsRemoved,
         keywordsRemoved,
         crawlerHitsRemoved,
         eventsRemoved,
         apiKeysRemoved,
         accountRemoved,
         umamiWebsitesDeleted,
         warnings: warnings.length > 0 ? warnings : undefined,
      });
   } catch (error) {
      console.log('[ERROR] Hard-deleting account data for account ', accountId, error);
      return res.status(400).json({ error: 'Error Deleting Account Data.' });
   }
};
