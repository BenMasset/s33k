import AuditLog from '../database/models/auditLog';
import { isMultiTenantEnabled } from './scope';

// recordAudit is the single, BEST-EFFORT writer of the privileged-access audit trail (the AuditLog
// model). It is called on operator instance actions (account list/create, cross-account key mint/
// revoke, waitlist read, feature-request read) and on the cron operator-wide keyword sweep.
//
// CONTRACT (do not regress):
//   - It NEVER throws into the request and NEVER blocks the response. A failed audit write must not
//     break the privileged action it is recording, so the whole body is wrapped and swallowed.
//   - It is a NO-OP when MULTI_TENANT is off. On a single-tenant install there is one operator and no
//     cross-tenant boundary to audit, so the table stays empty and the single-tenant path is
//     byte-for-byte unchanged (no extra write on any admin action).
//   - It records METADATA only (actor, action verb, target account/domain, route, a short note),
//     NEVER tenant content (no keywords, no events, no rankings) and NEVER secrets.
//
// It is awaited at call sites for ordering simplicity, but because it cannot throw, awaiting it is
// safe and adds at most one cheap insert to a privileged action (which is rare, not on a hot path).

export type AuditEvent = {
   actorAccountId: number | null,
   actorRole?: string | null,
   action: string,
   targetAccountId?: number | null,
   targetDomain?: string | null,
   route?: string | null,
   detail?: string | null,
};

export const recordAudit = async (event: AuditEvent): Promise<void> => {
   // No audit trail on a single-tenant install: there is no cross-tenant boundary to record.
   if (!isMultiTenantEnabled()) { return; }
   try {
      await AuditLog.create({
         actor_account_id: event.actorAccountId,
         actor_role: event.actorRole ?? null,
         action: event.action,
         target_account_id: event.targetAccountId ?? null,
         target_domain: event.targetDomain ?? null,
         route: event.route ?? null,
         detail: event.detail ?? null,
      });
   } catch (error) {
      // Best-effort: an audit-write failure must never break the privileged action being recorded.
      console.log('[WARN] recordAudit failed (non-blocking): ', error);
   }
};

export default recordAudit;
