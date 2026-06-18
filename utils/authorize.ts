import type { NextApiRequest, NextApiResponse } from 'next';
import resolveAccount, { ResolvedAccount } from './resolveAccount';
import { isAllowedApiRoute } from './allowedApiRoutes';
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

   // Per-domain SHARE key enforcement (the ONLY new enforcement for the sharing feature).
   // A share key lives on the OWNER's account, so scopeWhere(owner) and every pillar query
   // already work unchanged; the restriction is applied here, centrally, AFTER resolution.
   // A scoped key carries the single domain it may read; anything else is denied.
   //   - It is READ-ONLY regardless of role: reject any non-GET (same shape as the member
   //     rejection above). Defense in depth even though share keys are minted as members.
   //   - The request MUST target that exact domain. We CANONICALIZE both req.query.domain and the
   //     scoped domain and 403 unless they are equal. Canonicalizing both sides (instead of a raw
   //     byte compare) closes the normalization-mismatch escape: a route that re-derived the domain
   //     after this gate (slug-decode, www/protocol strip) used to check one string and look up a
   //     DIFFERENT one, letting a scoped key for "a-b.com" reach the sibling "a.b.com". Now the gate
   //     and every fixed route reason over the same canonical form, so they cannot diverge. A
   //     missing/array/non-string domain canonicalizes to '' and is denied, which keeps the prior
   //     behavior of blocking every no-domain route (portfolio, domains list, account, me, briefing
   //     without a domain) and every other domain.
   // Scoped keys only exist with MULTI_TENANT on (the per-account key path), so the flag-off
   // path never reaches here. When in doubt this path DENIES.
   const { scopedDomain } = resolved;
   if (scopedDomain) {
      if (req.method !== 'GET') {
         return { authorized: false, account: null, error: 'Read-only member' };
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
