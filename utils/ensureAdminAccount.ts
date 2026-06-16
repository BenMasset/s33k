import Account from '../database/models/account';
import { ADMIN_ACCOUNT_ID } from './scope';

// ensureAdminAccount guarantees that the seeded admin account row (ID = ADMIN_ACCOUNT_ID)
// exists in whatever database is connected. The create-account migration seeds this row,
// but migrations are not guaranteed to have run against every environment (notably the
// prod Postgres `account` table can be empty if the app booted before the migration ran).
// The account-management routes need a real admin row to exist as the FK target for new
// accounts and as a listable row, so this helper backfills it idempotently on demand.
//
// It is safe to call on every request: it is a single findOrCreate keyed on the primary
// key, so a concurrent or repeat call never creates a duplicate. It works identically on
// SQLite (local dev) and Postgres (hosted). It is a no-op once the row exists.
//
// This does NOT depend on MULTI_TENANT: the admin row is harmless when the flag is off
// (it is simply the home for the NULL-owner legacy data) and required when the flag is on.
// We cache the success so the happy path costs at most one DB round-trip per process.

let ensured = false;

const ensureAdminAccount = async (): Promise<void> => {
   if (ensured) { return; }
   try {
      await Account.findOrCreate({
         where: { ID: ADMIN_ACCOUNT_ID },
         defaults: { ID: ADMIN_ACCOUNT_ID, name: 'Admin', plan: 'admin', status: 'active' },
      });
      ensured = true;
   } catch (error) {
      // Never block a request on this best-effort backfill. A genuinely missing table is
      // surfaced by the route's own query; here we just log and let the caller proceed.
      console.log('[ERROR] ensureAdminAccount: ', error);
   }
};

export default ensureAdminAccount;
