// Multi-tenant scoping helpers for s33k.
//
// These are the single seam through which per-account scoping is threaded into the Sequelize queries,
// and they ARE wired into the data routes now (every Domain/Keyword/CrawlerHit/S33kEvent query spreads
// scopeWhere(account); per-domain routes go through resolveDomainAccess, which spreads it too). The
// flag-OFF / single-tenant path stays byte-for-byte identical to the original SerpBear (scopeWhere
// returns {}). Under the flag, the operator (admin sentinel) is a SCOPED tenant of its own null-owner
// partition, not a master reader: see the scopeWhere comment below for the full operator-isolation rule.

import type Account from '../database/models/account';

// The seeded admin account. NULL owner_id on legacy rows is treated as equivalent to
// owner_id = ADMIN_ACCOUNT_ID, so existing data needs no backfill to keep working.
export const ADMIN_ACCOUNT_ID = 1;

// True only when the hosted multi-tenant behavior is explicitly enabled. Default off,
// so with the flag unset the product behaves exactly like today's single-tenant app.
export const isMultiTenantEnabled = (): boolean => process.env.MULTI_TENANT === 'true';

// Returns a Sequelize `where` fragment that limits rows to the caller's account.
//
// THE OPERATOR-DATA-ISOLATION INVARIANT (do not regress): scopeWhere returns {} (an
// unrestricted, all-tenants read) ONLY when MULTI_TENANT is OFF. That is the legitimate
// single-owner self-host: one operator, all data is theirs, and the app is byte-for-byte
// identical to the original SerpBear. With the flag OFF nothing below this line runs.
//
// With the flag ON, NO account ever gets {} from this helper, INCLUDING the seeded
// admin/operator sentinel (ID = 1). The operator is scoped to its OWN data, which is the
// legacy NULL-owner partition (getmasset's rows live here, stamped owner_id=null by
// ownerIdFor(admin)). So the operator's everyday admin key/cookie is no longer a master
// reader of every tenant's content. A real tenant is scoped to its own owner_id.
//
// The ONE legitimate operator-wide read that still needs {} under flag-on (the cron SERP
// sweep that must scan EVERY tenant's keywords on the shared Serper key) does NOT come
// through here: it calls unscopedOperatorWhere() below, a named, greppable, single-purpose
// escape hatch gated on isAdminAccount at its call site. scopeWhere never returns {} for the
// operator under flag-on again, so route-level scoping can tighten without breaking cron.
export const scopeWhere = (account: Account | null | undefined): Record<string, unknown> => {
   if (!isMultiTenantEnabled()) { return {}; }
   // Flag ON: the operator (admin sentinel) and any null/undefined account resolve to the
   // operator's OWN data partition, the legacy NULL-owner rows. We match owner_id IS NULL via
   // Sequelize's native `{ col: null }` => `col IS NULL` translation (NOT { [Op.is]: null }),
   // which avoids importing Op from sequelize here: this module is loaded broadly (it is the auth
   // scoping seam), and a top-level `import { Op } from 'sequelize'` drags sequelize's ESM uuid dep
   // into jest and breaks every suite that touches a route (the same dependency-light rule that
   // keeps utils/allowedApiRoutes.ts model-free). { owner_id: null } is the equivalent, dep-free form.
   // This is the change that closes the operator-master-read hole: the operator becomes a normal
   // scoped tenant of the null-owner partition instead of seeing all tenants.
   if (!account || account.ID === ADMIN_ACCOUNT_ID) { return { owner_id: null }; }
   return { owner_id: account.ID };
};

// unscopedOperatorWhere is the SINGLE, EXPLICIT escape hatch for the ONE legitimate
// operator-wide read: the cron SERP sweep (pages/api/cron.ts) that must scan EVERY tenant's
// keywords/domains on the operator's shared Serper key, plus its spend-brake. It returns {}
// (no restriction) so the sweep covers all tenants. It is intentionally a DIFFERENT function
// from scopeWhere so that "read all tenants' data" is a named, greppable decision made at
// exactly one call site (cron, gated on isAdminAccount), and scopeWhere can stay tightened to
// the operator's own partition everywhere else. With the flag OFF this is moot (scopeWhere is
// already {}), so cron behavior is byte-for-byte unchanged on a single-tenant install.
export const unscopedOperatorWhere = (): Record<string, unknown> => ({});

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
