import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';

// /api/me returns the calling account as resolved by authorize(). Any authorized caller
// (legacy key, cookie session, or per-tenant key) may call it; the response is always the
// CALLER's own account, never another account's, so there is no cross-tenant surface here.
// With MULTI_TENANT off every authorized caller is the admin account, which is the correct
// and only answer in single-tenant mode.

type MeRes = {
   account?: { ID: number, name: string, plan: string, status: string } | null,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<MeRes>) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'GET') {
      return res.status(502).json({ error: 'Unrecognized Route.' });
   }
   // The legacy/cookie admin caller resolves to a bare in-memory sentinel ({ ID }) with no
   // name/plan/status, so we fall back to the seeded admin defaults to keep the response
   // shape stable. A real per-tenant account carries all four fields from the DB row.
   const isAdminSentinel = account.ID === ADMIN_ACCOUNT_ID;
   return res.status(200).json({
      account: {
         ID: account.ID,
         name: account.name ?? (isAdminSentinel ? 'Admin' : ''),
         plan: account.plan ?? (isAdminSentinel ? 'admin' : 'free'),
         status: account.status ?? 'active',
      },
   });
}
