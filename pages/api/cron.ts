import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
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
import { sendTrialEnding } from '../../utils/sendTrialEnding';

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
      // mode=dunning is the daily lifecycle sweep: mail the "your trial ends soon" notice to trialing
      // accounts whose trial_ends_at is within the next few days. Best-effort, paged, never scrapes.
      if (req.query.mode === 'dunning') {
         return cronDunningSweep(req, res, account);
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

// In-process drain mutex. s33k runs as a single long-lived Node process on Railway and the scheduler
// (cron.js) fires the full-scrape POST to ONE instance, so a module-global boolean is a sufficient
// guard: it stops two overlapping fires (e.g. a manual POST during the weekly run) from starting two
// concurrent drains that would double-charge Serper for the same keywords. It resets if the process
// restarts, at which point no drain is in flight anyway, and the next fire's stuck-row reset recovers
// any rows the dead drain left mid-flight.
let drainInFlight = false;

// Drain the FULL in-scope keyword set in bounded pages, stalest set first, each keyword claimed at
// most once per drain. This replaces both the original single-burst form (load every keyword, fan out
// all at once = the 50,000-simultaneous-SERP-call meltdown) AND the interim single-page-500 form
// (which silently starved every keyword past the lowest 500 IDs, so at 1000 sites only ~1% scraped).
//
// How it stays exactly-once and terminating: each page claims not-currently-updating, not-yet-seen
// keywords ordered stalest-first; EVERY claimed id (including ones the spend-brake then drops) is
// recorded in `seen` and excluded from later pages, so the cursor always advances and the loop ends
// when an empty page returns. A successful scrape bumps lastUpdated to now and a failed one leaves it
// (the hourly retry job re-scrapes errors), but the seen-set makes the drain correct regardless of
// per-keyword outcome, with no double-charge. Pages are AWAITED sequentially so concurrent SERP calls
// never exceed one page's SCRAPE_CONCURRENCY. Resumable: a crashed page leaves its rows updating:true,
// which the next drain's start-of-run reset clears so they scrape again.
const drainScrape = async (
   scope: Record<string, unknown>,
   settings: SettingsType,
   domainList: DomainType[],
): Promise<void> => {
   const pageSize = cronPageSize();
   const seen = new Set<number>();
   // Hard ceiling on page count so a logic error can never spin forever; far above any real table
   // (pageSize * maxPages keywords, = 5,000,000 at the default 500).
   const maxPages = 10000;
   try {
      for (let page = 0; page < maxPages; page += 1) {
         const seenIds = Array.from(seen);
         const where: Record<string, unknown> = {
            ...scope,
            updating: false,
            ...(seenIds.length ? { ID: { [Op.notIn]: seenIds } } : {}),
         };
         const rows: Keyword[] = await Keyword.findAll({ where, order: [['lastUpdated', 'ASC'], ['ID', 'ASC']], limit: pageSize });
         if (rows.length === 0) { break; }
         // Record EVERY claimed id (kept or spend-braked-away) so it is never re-queried: this is what
         // guarantees forward progress and termination even when scrapes fail or owners are inactive.
         rows.forEach((kw) => seen.add(kw.get('ID') as number));
         const kept = await applySpendBrake(rows, scope);
         if (kept.length > 0) {
            const keptIDs = kept.map((kw) => kw.get('ID') as number);
            await Keyword.update({ updating: true }, { where: { ID: keptIDs } });
            // Await each page before claiming the next so total in-flight SERP calls stay bounded by
            // one page's SCRAPE_CONCURRENCY rather than the whole table at once.
            await refreshAndUpdateKeywords(kept, settings, domainList);
         }
      }
   } catch (error) {
      console.log('[ERROR] CRON drain scrape: ', error);
   } finally {
      drainInFlight = false;
   }
};

const cronRefreshkeywords = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   // Claim the drain mutex synchronously (no await between the check and the set) so two near-
   // simultaneous fires cannot both pass the guard. A drain already running finishes the full set,
   // so a second fire is a no-op that still reports started:true.
   if (drainInFlight) {
      return res.status(200).json({ started: true });
   }
   drainInFlight = true;
   try {
      const settings = await getAppSettings();
      if (!settings || (settings && settings.scraper_type === 'never')) {
         drainInFlight = false;
         return res.status(400).json({ started: false, error: 'Scraper has not been set up yet.' });
      }
      const scope = await cronScopeFor(account, 'cron.sweep');
      const allDomains: Domain[] = await Domain.findAll({ where: { ...scope } });
      const domainList: DomainType[] = allDomains.map((d) => d.get({ plain: true }));

      // Recover rows left updating:true by a drain that died mid-flight in a PRIOR run, so they are
      // eligible to scrape again (the resumability guarantee). Safe because drainInFlight proves no
      // OTHER full drain is running right now; the only collision is an hourly-retry row's in-flight
      // flag, which is benign (that retry settles updating:false on its own; at most a rare harmless
      // re-scrape). Best-effort: a failure here must not abort the sweep.
      try {
         await Keyword.update({ updating: false }, { where: { ...scope, updating: true } });
      } catch (resetErr) {
         console.log('[WARN] CRON stuck-updating reset failed (continuing): ', resetErr);
      }

      // Fire-and-forget the paged drain; return immediately so the request cannot time out (the same
      // non-blocking started:true contract as before, now covering the FULL keyword set). drainScrape
      // releases the mutex in its finally.
      drainScrape(scope, settings, domainList);

      return res.status(200).json({ started: true });
   } catch (error) {
      drainInFlight = false;
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

// How many days before trial end to start the "trial ending" notice. A trialing account is mailed
// once its trial_ends_at falls inside this window (and before it expires). Env-overridable; default 3.
const dunningWindowDays = (): number => {
   const raw = parseInt(process.env.DUNNING_WINDOW_DAYS || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 3;
};

// IDEMPOTENCY without a DB column (this agent must not edit the Account model): a per-process map of
// accountId -> a coarse time bucket (UTC day) it was last notified in. The dunning sweep fires once a
// day, so a same-bucket repeat (e.g. a manual re-POST on the same day, or two near-simultaneous fires)
// is suppressed and a victim is not double-mailed. It resets on process restart, which at worst allows
// ONE extra notice after a restart on the same day; that is acceptable for a best-effort lifecycle
// nudge and is far cheaper than the alternative (a model migration owned by another agent). The day
// bucket also means the SAME account naturally becomes eligible again the next day if it is still in
// the window, so a 3-day window yields at most ~3 reminders per trial, not a per-tick flood.
const notifiedBucketByAccount = new Map<number, string>();
const dayBucket = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

// THE DUNNING SWEEP (POST /api/cron?mode=dunning). With MULTI_TENANT on AND the operator (admin)
// caller, find trialing accounts whose trial_ends_at is within the next dunningWindowDays and still in
// the future, and mail each the trial-ending notice (best-effort, never throws). Paged with
// cronPageSize so a large account table is processed in bounded chunks, not loaded all at once. The
// notify happens fire-and-forget (started:true returns immediately; the same non-blocking contract as
// the scrape) so the outbound Resend calls cannot time the request out. Flag-off / non-admin: no-op
// (no trialing accounts exist in single-tenant), returns started:true. cronScopeFor is reused only to
// keep the operator-privilege audit pattern consistent; the account query itself is operator-wide by
// nature (lifecycle email is an instance-admin action, like the SERP sweep).
const cronDunningSweep = async (req: NextApiRequest, res: NextApiResponse<CRONRefreshRes>, account?: Account | null) => {
   // Flag-off or a non-admin caller: there are no trialing tenants to notify in single-tenant, and a
   // tenant key must not trigger an instance-wide lifecycle sweep. No-op, success shape unchanged.
   if (!isMultiTenantEnabled() || !isAdminAccount(account)) {
      return res.status(200).json({ started: true });
   }
   // Reuse the operator-wide audit pattern (best-effort, never blocks). cronScopeFor returns {} for the
   // admin under the flag; the account query below is operator-wide by design (lifecycle is admin work).
   await cronScopeFor(account, 'cron.dunning');

   // Kick the paged notify off and return immediately, so a big account list / slow Resend cannot time
   // the request out. drainDunning is best-effort throughout and swallows its own errors.
   drainDunning();
   return res.status(200).json({ started: true });
};

// Page through trialing accounts whose trial_ends_at is in (now, now + windowDays], mailing the
// trial-ending notice once per account per UTC day. Bounded pages (cronPageSize) and a cursor on the
// account primary key so a 1000+ account table is processed in chunks, never materialized at once.
// Best-effort: every send is awaited only to bound concurrency to one page at a time, and a single bad
// account never aborts the sweep (sendTrialEnding never throws; the loop is wrapped regardless).
const drainDunning = async (): Promise<void> => {
   try {
      const now = Date.now();
      const windowEnd = new Date(now + dunningWindowDays() * 24 * 60 * 60 * 1000);
      const nowDate = new Date(now);
      const bucket = dayBucket(now);
      const pageSize = cronPageSize();
      const maxPages = 10000;
      let lastId = 0;
      for (let page = 0; page < maxPages; page += 1) {
         const where: Record<string, unknown> = {
            subscription_status: 'trialing',
            trial_ends_at: { [Op.gt]: nowDate, [Op.lte]: windowEnd },
            ID: { [Op.gt]: lastId },
         };
         // eslint-disable-next-line no-await-in-loop
         const accounts: Account[] = await AccountModel.findAll({ where, order: [['ID', 'ASC']], limit: pageSize });
         if (accounts.length === 0) { break; }
         lastId = accounts[accounts.length - 1].ID;
         // Skip any account already notified in this UTC-day bucket so a same-day re-fire does not
         // double-mail. The bucket advances daily, so a still-in-window account is re-eligible
         // tomorrow (at most ~one notice per day across the window).
         const toNotify = accounts.filter((acc) => notifiedBucketByAccount.get(acc.ID) !== bucket);
         for (const acc of toNotify) {
            notifiedBucketByAccount.set(acc.ID, bucket);
            // eslint-disable-next-line no-await-in-loop
            await sendTrialEnding(acc);
         }
      }
   } catch (error) {
      console.log('[ERROR] CRON dunning sweep: ', error);
   }
};
