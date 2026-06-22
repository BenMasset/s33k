import {
   Table, Model, Column, DataType, PrimaryKey,
} from 'sequelize-typescript';

// An AuditLog row records a PRIVILEGED or CROSS-TENANT access event: an operator (admin sentinel)
// instance action, a cron operator-wide keyword sweep, or any other path where the operator touches
// data or metadata beyond a single ordinary tenant request. It is deliberately CHEAP and COARSE: we
// do NOT log every per-row analytics read (that would be high-volume noise and a privacy footgun);
// we log the few PRIVILEGED ACCESS events that matter for a trust/audit trail under multi-tenancy.
//
// WHY this exists: with MULTI_TENANT on, the operator is now a scoped tenant for its own data (see
// utils/scope.ts), but it retains INSTANCE-admin powers (list accounts, mint/revoke keys, read the
// waitlist, run the cron sweep). Those privileged actions should leave a record, so there is an
// honest answer to "what can the operator do, and is it logged?". recordAudit (utils/auditLog.ts) is
// the single best-effort writer; it never blocks or throws into a request.
//
// Column names BYTE-MATCH the create-audit-log-table migration (Postgres is case-sensitive). The PK
// attribute is "ID" (uppercase) like every other model, mapped to the lowercase "id" column. Free-text
// columns are TEXT (never STRING/VARCHAR(255)) to avoid the prod-Postgres truncation class documented
// in CLAUDE.md. The table is inert with the flag off (the single admin runs no privileged-access path
// that writes here on a single-tenant install, and recordAudit is a no-op when MULTI_TENANT is off).
@Table({
  timestamps: true,
  tableName: 'audit_log',
})

class AuditLog extends Model {
   @PrimaryKey
   @Column({
      type: DataType.INTEGER, allowNull: false, primaryKey: true, autoIncrement: true, field: 'id',
   })
   ID!: number;

   // The account that PERFORMED the privileged action (the operator/admin sentinel for instance
   // actions and the cron sweep). Nullable so a record can be written even if the actor id is unknown.
   @Column({ type: DataType.INTEGER, allowNull: true })
   actor_account_id!: number | null;

   // The actor's role at the time ('admin' for the operator). TEXT, nullable.
   @Column({ type: DataType.TEXT, allowNull: true })
   actor_role!: string | null;

   // A short, stable action verb: 'cron.sweep', 'cron.retry', 'account.list', 'account.create',
   // 'account-key.mint', 'account-key.revoke', 'waitlist.read', 'feature-request.read'. Required.
   @Column({ type: DataType.TEXT, allowNull: false })
   action!: string;

   // The account the action TARGETED, when applicable (e.g. minting a key for another account). Null
   // for instance-wide actions (the cron sweep targets all tenants, not one) and self-targeting ones.
   @Column({ type: DataType.INTEGER, allowNull: true })
   target_account_id!: number | null;

   // The domain the action targeted, when applicable. Null for non-domain actions.
   @Column({ type: DataType.TEXT, allowNull: true })
   target_domain!: string | null;

   // The API route the action came through (e.g. '/api/cron', '/api/account'). TEXT, nullable.
   @Column({ type: DataType.TEXT, allowNull: true })
   route!: string | null;

   // A short free-text note for context. NEVER store secrets or tenant content here. TEXT, nullable.
   @Column({ type: DataType.TEXT, allowNull: true })
   detail!: string | null;
}

export default AuditLog;
