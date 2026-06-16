import type { NextApiRequest, NextApiResponse } from 'next';
import resolveAccount, { ResolvedAccount } from './resolveAccount';
import { isAllowedApiRoute } from './allowedApiRoutes';

// authorize is the multi-tenant-aware entry point for data routes. It resolves the
// caller to an account (cookie -> admin, legacy global key -> admin, per-tenant key ->
// that account when MULTI_TENANT is on) AND enforces the API-route whitelist for key
// callers, then returns the resolved account so the route can scope its queries with
// scopeWhere(account) / ownerIdFor(account). When MULTI_TENANT is off, every authorized
// caller resolves to admin and scopeWhere returns {}, so behavior is identical to today.
const authorize = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const resolved = await resolveAccount(req, res);
   if (!resolved.authorized) { return resolved; }

   // Cookie/UI callers are unrestricted. Anyone presenting a Bearer key must be hitting a
   // whitelisted route, matching the original verifyUser behavior.
   const usedBearer = Boolean(req.headers.authorization);
   if (usedBearer && !isAllowedApiRoute(req)) {
      return { authorized: false, account: null, error: 'This Route cannot be accessed with API.' };
   }
   return resolved;
};

export default authorize;
