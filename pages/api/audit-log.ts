import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import AuditLog from '../../database/models/auditLog';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { isAdminAccount } from '../../utils/scope';

// OPERATOR-ONLY read of the privileged-access audit trail (the AuditLog rows recordAudit writes).
//
// This is an INSTANCE-admin route, not a tenant-data route: it returns the operator's own record of
// privileged actions (cron sweeps, account list/create, cross-account key mint/revoke, waitlist /
// feature-request reads), which is METADATA only (actor, action verb, target account/domain, route,
// note, time), NEVER tenant content. It is gated by isAdminAccount (the admin sentinel, never a
// scoped share-key account) exactly like /api/account and /api/waitlist, so a tenant key or share key
// can never read it (belt: the share-key allowlist denies it; this route is not in the scoped set).
//
// Meaningful only with MULTI_TENANT on (recordAudit is a no-op with the flag off, so the table is
// empty on a single-tenant install). With the flag off the only caller is the admin, so the gate is a
// no-op and the route simply returns whatever empty trail exists.

type AuditRow = {
   ID: number,
   actor_account_id: number | null,
   actor_role: string | null,
   action: string,
   target_account_id: number | null,
   target_domain: string | null,
   route: string | null,
   detail: string | null,
   at: string | null,
};

type AuditListRes = {
   events?: AuditRow[],
   error?: string | null,
};

// Cap how many rows a single read returns so the response is bounded regardless of trail size.
const MAX_ROWS = 500;

export default async function handler(req: NextApiRequest, res: NextApiResponse<AuditListRes>) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (!isAdminAccount(account)) {
      return res.status(403).json({ error: 'Admin access required.' });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   try {
      const limitRaw = Number(req.query.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_ROWS) : MAX_ROWS;
      const rows = await AuditLog.findAll({ order: [['createdAt', 'DESC']], limit });
      const events: AuditRow[] = rows.map((row) => ({
         ID: row.ID,
         actor_account_id: row.actor_account_id,
         actor_role: row.actor_role,
         action: row.action,
         target_account_id: row.target_account_id,
         target_domain: row.target_domain,
         route: row.route,
         detail: row.detail,
         at: row.get('createdAt') ? new Date(row.get('createdAt') as Date).toJSON() : null,
      }));
      return res.status(200).json({ events });
   } catch (err) {
      console.log('[ERROR] Reading audit log: ', err);
      return res.status(400).json({ error: 'Error reading audit log.' });
   }
}
