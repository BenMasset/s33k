import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import authorize from '../../../utils/authorize';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { ADMIN_ACCOUNT_ID } from '../../../utils/scope';
import { resolveCaps, isAccountActive } from '../../../utils/plans';

// GET /api/billing/status -> { subscription_status, trial_ends_at, paid_sites, isActive, caps }
// Returns the CALLER's own billing state + effective caps, so the app can show a trial countdown,
// the purchased site count, and an upgrade prompt. Authed via authorize(); whitelisted in
// allowedApiRoutes; NOT a scoped-key route. Always returns the caller's own account, so there is no
// cross-tenant surface. With MULTI_TENANT off the admin sentinel resolves to always-active + the most
// generous caps, which is the correct single-tenant answer. caps is trimmed to the fields the UI
// needs (sites / keywords / cadenceDays) in the per-unit model.

// The trimmed caps the status view exposes: site count, keyword cap, and the weekly rank cadence.
type StatusCaps = { sites: number, keywords: number, cadenceDays: number };

type BillingStatusRes = {
   // `plan` retained ONLY to flag the single-tenant admin sentinel ('admin') so the UI hides the
   // billing notice for it. There are no named tiers; a real tenant has no plan.
   plan?: string | null,
   subscription_status?: string | null,
   trial_ends_at?: string | null,
   paid_sites?: number | null,
   isActive?: boolean,
   caps?: StatusCaps,
   error?: string | null,
};

// Trim the full PlanCaps to the three fields the status view returns.
const trimCaps = (caps: { sites: number, keywords: number, cadenceDays: number }): StatusCaps => ({
   sites: caps.sites,
   keywords: caps.keywords,
   cadenceDays: caps.cadenceDays,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse<BillingStatusRes>) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }

   // The legacy/cookie admin caller resolves to a bare { ID } sentinel with no billing fields, so
   // fall back to a stable always-active shape. A real tenant account carries the billing columns.
   const isAdminSentinel = account.ID === ADMIN_ACCOUNT_ID && account.subscription_status === undefined;
   if (isAdminSentinel) {
      return res.status(200).json({
         plan: 'admin',
         subscription_status: 'active',
         trial_ends_at: null,
         paid_sites: null,
         isActive: true,
         caps: trimCaps(resolveCaps(account)),
      });
   }

   // Reload the row to ensure all billing columns are present (the resolved tenant account is the DB
   // row already, but reloading by id is robust against a partially-hydrated sentinel).
   const row = await Account.findOne({ where: { ID: account.ID } });
   const effective = row || account;
   const trialEndsAt = effective.trial_ends_at ? new Date(effective.trial_ends_at).toJSON() : null;
   return res.status(200).json({
      subscription_status: effective.subscription_status ?? null,
      trial_ends_at: trialEndsAt,
      paid_sites: effective.paid_sites ?? null,
      isActive: isAccountActive(effective),
      caps: trimCaps(resolveCaps(effective)),
   });
}
