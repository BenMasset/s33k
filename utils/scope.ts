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

// A SCOPED account is the account a read-only per-domain SHARE key resolves to. The share
// key is minted on the domain OWNER's account, which can be the seeded ADMIN account (a
// domain with owner_id null belongs to admin). We deliberately do NOT change account.ID for
// a share key, because scopeWhere/ownerIdFor must keep resolving the owner's data correctly
// (the allowlisted per-domain routes isolate by the globally-unique domain name). Instead we
// tag the resolved Account object with a non-enumerable __scoped marker so PRIVILEGE checks
// (isAdminAccount) can treat it as a non-admin member, while data-scoping stays unchanged.
//
// SCOPED_MARKER is a Symbol so it cannot collide with any model attribute and is not
// serialized by get({ plain: true }) / JSON.stringify, so it never leaks into a response.
export const SCOPED_MARKER = Symbol('s33kScopedAccount');

// markScopedAccount stamps the non-enumerable scoped marker on an Account object and returns
// it. Called by resolveAccount when a share key authorizes, so every downstream isAdminAccount
// check sees a non-admin even though account.ID is still the (admin) owner's id.
export const markScopedAccount = <T extends object>(account: T): T => {
   Object.defineProperty(account, SCOPED_MARKER, { value: true, enumerable: false, configurable: true, writable: false });
   return account;
};

// isScopedAccount is true only for the share-key account tagged by markScopedAccount.
export const isScopedAccount = (account: Account | null | undefined): boolean => Boolean(
   account && (account as unknown as Record<symbol, unknown>)[SCOPED_MARKER] === true,
);

// isAdminAccount is the single privilege predicate for "may this caller use admin-only routes
// (list/create accounts, read every feature request, read the waitlist)". It is the admin
// sentinel check account.ID === ADMIN_ACCOUNT_ID, EXCEPT a scoped share-key account is NEVER
// admin even when its id is the admin id. Use this everywhere an admin gate is needed instead
// of an inline account.ID === ADMIN_ACCOUNT_ID, so a share key can never inherit admin rights.
export const isAdminAccount = (account: Account | null | undefined): boolean => Boolean(
   account && account.ID === ADMIN_ACCOUNT_ID && !isScopedAccount(account),
);
