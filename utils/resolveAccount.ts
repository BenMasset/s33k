import crypto from 'crypto';
import Cookies from 'cookies';
import jwt from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';
import Account from '../database/models/account';
import ApiKey from '../database/models/apiKey';
import { ADMIN_ACCOUNT_ID, isMultiTenantEnabled } from './scope';

// resolveAccount is the multi-tenant sibling of verifyUser. It resolves the calling
// Bearer API key (or cookie session) to an Account, defaulting to the seeded admin
// account so nothing breaks. It does NOT enforce the route whitelist; routes still call
// verifyUser for the existing authorization + whitelist behavior, then call this to
// learn WHICH account is calling. No route adopts this yet; it ships dark.
//
// Back-compat guarantees:
//  - When MULTI_TENANT is off (the default), every authorized caller resolves to the
//    admin account. The legacy process.env.APIKEY keeps working forever.
//  - When MULTI_TENANT is on, the legacy process.env.APIKEY still resolves to the admin
//    account. Any other Bearer key is looked up in the api_key table.
//  - A valid cookie session resolves to the admin account in wave 1 (there is no users
//    table yet).

export type ResolvedAccount = {
   authorized: boolean,
   account: Account | null,
   error?: string,
};

// The in-memory stand-in for the seeded admin account row (ID = 1). We avoid a DB read
// on the hot path for the legacy key; the scoping helper only cares about the ID.
const adminAccount = (): Account => ({ ID: ADMIN_ACCOUNT_ID } as Account);

// Hash a full key the same way mint-time will: SHA-256, hex-encoded. Storing only the
// hash means a leaked DB dump does not leak usable keys.
export const hashApiKey = (fullKey: string): string => crypto.createHash('sha256').update(fullKey).digest('hex');

// The prefix we index and look up on. Matches the `s33k_<random>` key format: take a
// short, stable leading slice for the indexed lookup.
export const apiKeyPrefix = (fullKey: string): string => fullKey.slice(0, 12);

const resolveAccount = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const cookies = new Cookies(req, res);
   const token = cookies && cookies.get('token');

   // Cookie session: admin account in wave 1 (no users table yet).
   if (token && process.env.SECRET) {
      let valid = false;
      jwt.verify(token, process.env.SECRET, (err) => { valid = !err; });
      if (valid) { return { authorized: true, account: adminAccount() }; }
   }

   const authHeader = req.headers.authorization;
   const bearer = authHeader ? authHeader.substring('Bearer '.length) : '';

   // Legacy global key always resolves to admin, regardless of the flag.
   if (bearer && bearer === process.env.APIKEY) {
      return { authorized: true, account: adminAccount() };
   }

   // With multi-tenancy off, no other key path exists: behave exactly like today.
   if (!isMultiTenantEnabled()) {
      if (bearer) { return { authorized: false, account: null, error: 'Invalid API Key Provided.' }; }
      return { authorized: false, account: null, error: 'Not authorized' };
   }

   // Multi-tenant on: look up a per-account key by prefix, then verify the hash.
   if (bearer) {
      const prefix = apiKeyPrefix(bearer);
      const candidate = await ApiKey.findOne({ where: { key_prefix: prefix, revoked_at: null } });
      if (candidate && candidate.key_hash === hashApiKey(bearer)) {
         const account = await Account.findOne({ where: { ID: candidate.account_id } });
         if (account && account.status === 'active') {
            // Best-effort observability; never block auth on this write.
            try {
               candidate.last_used_at = new Date();
               await candidate.save();
            } catch (saveError) {
               // ignore
            }
            return { authorized: true, account };
         }
      }
      return { authorized: false, account: null, error: 'Invalid API Key Provided.' };
   }

   return { authorized: false, account: null, error: 'Not authorized' };
};

export default resolveAccount;
