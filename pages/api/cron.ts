import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Keyword from '../../database/models/keyword';
import Domain from '../../database/models/domain';
import { getAppSettings } from './settings';
import authorize from '../../utils/authorize';
import {
   scopeWhere, isMultiTenantEnabled, ADMIN_ACCOUNT_ID, isAdminAccount, unscopedOperatorWhere,
} from '../../utils/scope';
import { recordAudit } from '../../utils/auditLog';
import AccountModel from '../../database/models/account';
import type Account from '../../database/models/account';
import refreshAndUpdateKeywords from '../../utils/refresh';
import { isAccountActive } from '../../utils/plans';
import { failedRetryWhere } from '../../utils/scraper';

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
      // mode=retry is the hourly DB-backed retry job (replaces the old failed_queue.json file): it
      // re-scrapes ONLY keywords that currently have a real lastUpdateError. Any other POST is the
      // normal full scrape cron. Both reuse the same Bearer auth and the same spend-brake below.
      if (req.query.mode === 'retry') {
         return cronRetryFailedKeywords(req, res, account);
      }
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

// SPEND BRAKE (the cost protection): drop keywords belonging to an INACTIVE account (expired trial /
// canceled / past_due) so a lapsed account cannot keep burning the operator's paid SERP budget. Only
// applies with MULTI_TENANT on AND when the operator runs cron account-wide (scope {}); with the flag
// off there is one always-active admin account, so this returns the input unchanged and the
// single-tenant path is byte-for-byte identical. Shared by the full scrape and the retry job.
const applySpendBrake = async (keywords: Keyword[], scope: Record<string, unknown>): Promise<Keyword[]> => {
   if (!isMultiTenantEnabled() || Object.keys(scope).length !== 0 || keywords.length === 0) {
      return keywords;
   }
   const activeById = await activeOwnerMap(keywords);
   return keywords.filter((kw) => {
      const ownerId = (kw.get('owner_id') as number | null) ?? ADMIN_ACCOUNT_ID;
      return activeById.get(ownerId) === true;
   });
};

// Resolve the keyword/domain scope for a cron run. The cron sweep is intentionally INSTANCE-WIDE
// when the OPERATOR runs it (the operator owns the shared Serper key and refreshes every tenant's
// rankings), so the operator gets unscopedOperatorWhere() = {} via the named escape hatch. Any
// OTHER caller (a tenant key that somehow reaches cron) stays scoped to its own rows via scopeWhere,
// so a tenant can never trigger an all-tenants scrape. With MULTI_TENANT off, isAdminAccount is true
// for the single admin and scopeWhere is already {}, so this returns {} either way (byte-for-byte
// unchanged). When the operator runs the sweep under flag-on, we audit-log the privileged all-tenants
// access (best-effort, never blocks the run) so there is a record of every instance-wide data touch.
const cronScopeFor = async (
   account: Account | null | undefined,
   action: string,
): Promise<Record<string, unknown>> => {
   if (isMultiTenantEnabled() && isAdminAccount(account)) {
      await recordAudit({
         actorAccountId: account ? account.ID : ADMIN_ACCOUNT_ID,
         actorRole: 'admin',
         action,
         route: '/api/cron',
         detail: 'operator-wide keyword sweep across all tenants',
      });
      return unscopedOperatorWhere();
   }
   return scopeWhere(account);
};

// CRON_PAGE_SIZE bounds how many keyword rows are claimed + held in memory per page of the sweep,
// so a 1000-site instance is processed in bounded pages instead of materializing every tenant's
// 50,000 keyword model instances at once. Env-overridable; default 500. A non-positive/non-numeric
// value falls back to the default. The single-tenant install (a handful of keywords) fits in one page.
const cronPageSize = (): number => {
   const raw = parseInt(process.env.CRON_PAGE_SIZE || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 500;
};

const cronRefreshkeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = await cronScopeFor(account, 'cron.sweep');
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      // Claim the keyword set FIRST, then mark only the CLAIMED rows updating:true. The old form ran
      // a blanket Keyword.update({updating:true},{where:{}}) over EVERY tenant's rows before reading
      // them, and loaded all keywords at once. We now read a bounded page (ID-ASC), apply the
      // spend-brake to the claimed page, mark exactly those IDs updating, and hand the page to refresh
      // (which is itself bounded-concurrency, so the per-page scrape burst can never exceed
      // SCRAPE_CONCURRENCY). NOTE (single-pass for safety): this reads ONE bounded page rather than
      // cursor-paging the whole table, because a full resumable cursor/claim rewrite is the riskiest
      // change here (correctness: every due keyword scraped exactly once, no double-charge to Serper).
      // The bounded concurrency from utils/scrape-queue.ts already removes the 50,000-simultaneous-call
      // meltdown, which was the hard blocker. The cursor/tick split (process every page across ticks,
      // fully resumable) is documented as a follow-up rather than shipped unproven. See cron notes.
      const limit = cronPageSize();
      let keywordQueries: Keyword[] = await Keyword.findAll({ where: { ...scope }, order: [['ID', 'ASC']], limit });

      keywordQueries = await applySpendBrake(keywordQueries, scope);

      if (keywordQueries.length > 0) {
         // Mark exactly the claimed (post-spend-brake) keyword IDs as updating, instead of a blanket
         // all-tenants update. A lapsed account's dropped keywords are not flipped to updating.
         const claimedIDs = keywordQueries.map((kw) => kw.get('ID') as number);
         await Keyword.update({ updating: true }, { where: { ID: claimedIDs } });
         // Fire-and-forget, preserving the original non-blocking "started: true" semantics: the SERP
         // sweep runs in the background and the request returns immediately so it cannot time out.
         refreshAndUpdateKeywords(keywordQueries, settings, domainList);
      }

      return res.status(200).json({ started: true });
   } catch (error) {
      console.log('[ERROR] CRON Refreshing Keywords: ', error);
      return res.status(400).json({ started: false, error: 'CRON Error refreshing keywords!' });
   }
};

// The hourly DB-backed retry job (POST /api/cron?mode=retry): re-scrape ONLY keywords that currently
// have a real lastUpdateError and are not mid-scrape (failedRetryWhere). This replaces the old
// failed_queue.json file + /api/refresh?id=... path; the queue is now derived from the keyword rows,
// so it is naturally tenant-scoped (scopeWhere) and never goes stale against a separate file. The
// same spend-brake applies: a lapsed account's failed keywords are not retry-scraped.
const cronRetryFailedKeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = await cronScopeFor(account, 'cron.retry');
      let keywordQueries: Keyword[] = await Keyword.findAll({ where: { ...failedRetryWhere(), ...scope } });
      if (keywordQueries.length === 0) {
         return res.status(200).json({ started: true });
      }
      // Mark exactly the to-retry set updating, so the next retry tick does not double-fire them.
      const retryIDs = keywordQueries.map((kw) => kw.get('ID') as number);
      await Keyword.update({ updating: true }, { where: { ID: retryIDs } });
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      keywordQueries = await applySpendBrake(keywordQueries, scope);

      refreshAndUpdateKeywords(keywordQueries, settings, domainList);

      return res.status(200).json({ started: true });
   } catch (error) {
      console.log('[ERROR] CRON Retrying Failed Keywords: ', error);
      return res.status(400).json({ started: false, error: 'CRON Error retrying keywords!' });
   }
};
