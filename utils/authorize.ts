import type { NextApiRequest, NextApiResponse } from 'next';
import resolveAccount, { ResolvedAccount } from './resolveAccount';
import { isAllowedApiRoute, isScopedKeyAllowedRoute } from './allowedApiRoutes';
import { canonicalizeDomain } from './canonical-domain';

// authorize is the multi-tenant-aware entry point for data routes. It resolves the
// caller to an account (cookie -> admin, legacy global key -> admin, per-tenant key ->
// that account when MULTI_TENANT is on) AND enforces the API-route whitelist for key
// callers, then returns the resolved account so the route can scope its queries with
// scopeWhere(account) / ownerIdFor(account). When MULTI_TENANT is off, every authorized
// caller resolves to admin and scopeWhere returns {}, so behavior is identical to today.
const authorize = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const resolved = await resolveAccount(req, res);
   if (!resolved.authorized) { return resolved; }

   // Read-only member keys may only read. Any non-GET (write) request from a member key is
   // rejected before it reaches the route. Admin and legacy keys (role 'admin') are
   // unaffected; members only ever exist with MULTI_TENANT on, so the flag-off path never
   // hits this. GET is the only safe-method we expose to keys, so we gate strictly to it.
   if (resolved.role === 'member' && req.method !== 'GET') {
      return { authorized: false, account: null, error: 'Read-only member' };
   }

   // Per-domain SHARE key enforcement. A share key (resolved.scopedDomain set) is the highest-risk
   // credential s33k mints: a read-only link to ONE domain's data. The enforcement here is a POSITIVE
   // ALLOWLIST, not a blacklist-by-presence. The prior gate only checked that ?domain= matched the
   // scoped domain, which let a share key reach routes that IGNORE req.query.domain (export, portfolio,
   // domains GET, account, me, invite, ...) and return account- or instance-wide data via
   // scopeWhere(account). Worse, a share key minted on the admin account inherited admin scope (we now
   // also strip that in resolveAccount, defense in depth), so those routes dumped the whole instance.
   // A scoped key is now allowed ONLY when ALL of the following hold; any failure DENIES:
   //   1. The method is GET. Share keys never write (same shape as the member rejection above).
   //   2. The route is in the curated positive allowlist of per-domain-gated GET reads
   //      (isScopedKeyAllowedRoute). Anything not proven to gate on req.query.domain is denied.
   //   3. The canonical ?domain= equals the key's canonical scoped_domain. We canonicalize BOTH
   //      sides (not a raw byte compare) to close the normalization-mismatch escape: a route that
   //      re-derived the domain after this gate (slug-decode, www/protocol strip) used to check one
   //      string and look up a DIFFERENT one, letting a scoped key for "a-b.com" reach the sibling
   //      "a.b.com". Now the gate and every fixed route reason over the same canonical form. A
   //      missing / array / non-string domain canonicalizes to '' and is denied.
   // Scoped keys only exist with MULTI_TENANT on (the per-account key path), so the flag-off path
   // never reaches here. When in doubt this path DENIES.
   const { scopedDomain } = resolved;
   if (scopedDomain) {
      if (req.method !== 'GET') {
         return { authorized: false, account: null, error: 'Read-only member' };
      }
      if (!isScopedKeyAllowedRoute(req)) {
         return { authorized: false, account: null, error: 'This Route cannot be accessed with a share key.' };
      }
      const requestedDomain = canonicalizeDomain(req.query.domain);
      if (!requestedDomain || requestedDomain !== canonicalizeDomain(scopedDomain)) {
         return { authorized: false, account: null, error: `This key is limited to ${scopedDomain}.` };
      }
   }

   // Cookie/UI callers are unrestricted. Anyone presenting a Bearer key must be hitting a
   // whitelisted route, matching the original verifyUser behavior.
   const usedBearer = Boolean(req.headers.authorization);
   if (usedBearer && !isAllowedApiRoute(req)) {
      return { authorized: false, account: null, error: 'This Route cannot be accessed with API.' };
   }
   return resolved;
};

export default authorize;
