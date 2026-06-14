// Multi-tenant scoping helpers for s33k.
//
// These are the single seam through which per-account scoping is threaded into the
// existing Sequelize queries. Nothing in this file is wired into any route yet: this
// phase ships the schema, the models, and these helpers, but does NOT scope existing
// queries by owner (that is a later, attended step). The helpers are written so that
// when routes adopt them, the admin/legacy path stays byte-for-byte identical to today.

import type Account from '../database/models/account';

// The seeded admin account. NULL owner_id on legacy rows is treated as equivalent to
// owner_id = ADMIN_ACCOUNT_ID, so existing data needs no backfill to keep working.
export const ADMIN_ACCOUNT_ID = 1;

// True only when the hosted multi-tenant behavior is explicitly enabled. Default off,
// so with the flag unset the product behaves exactly like today's single-tenant app.
export const isMultiTenantEnabled = (): boolean => process.env.MULTI_TENANT === 'true';

// Returns a Sequelize `where` fragment that limits rows to the caller's account.
// Admin/legacy callers (and any caller while MULTI_TENANT is off) get {} (no
// restriction), so existing data with NULL owner_id stays fully visible and every
// query is identical to today. A real tenant gets { owner_id: account.ID }.
export const scopeWhere = (account: Account | null | undefined): Record<string, unknown> => {
   if (!isMultiTenantEnabled()) { return {}; }
   if (!account || account.ID === ADMIN_ACCOUNT_ID) { return {}; }
   return { owner_id: account.ID };
};

// Returns the owner_id to stamp on a newly created row for the caller's account.
// Admin/legacy callers (and any caller while MULTI_TENANT is off) get null, matching
// how existing rows are stored today. A real tenant gets their account ID.
export const ownerIdFor = (account: Account | null | undefined): number | null => {
   if (!isMultiTenantEnabled()) { return null; }
   if (!account || account.ID === ADMIN_ACCOUNT_ID) { return null; }
   return account.ID;
};
