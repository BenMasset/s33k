import crypto from 'crypto';
import Cookies from 'cookies';
import jwt from 'jsonwebtoken';
import type { NextApiRequest, NextApiResponse } from 'next';
import Account from '../database/models/account';
import ApiKey from '../database/models/apiKey';
import { ADMIN_ACCOUNT_ID, isMultiTenantEnabled, markScopedAccount } from './scope';

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
   // The role of the api_key that authorized this request, when known. 'admin' for the
   // legacy global key, cookie sessions, and per-account admin keys; 'member' for a
   // read-only member key (internal-invite seat). Undefined when no key resolved. authorize()
   // reads this to reject writes from member keys. Only members exist with MULTI_TENANT on.
   role?: 'admin' | 'member',
   // When set, the authorizing key is a per-domain SHARE key: read-only and limited to exactly
   // this one domain. authorize() enforces it (GET-only AND req.query.domain === scopedDomain).
   // Null/undefined for legacy, cookie, admin, and ordinary per-account keys (the unrestricted
   // case). Only ever set with MULTI_TENANT on, where the per-account key path runs.
   scopedDomain?: string | null,
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

// Base62 alphabet for human-friendly, URL-safe key bodies (no +, /, or = padding).
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Mint a fresh full API key in the `s33k_<random>` format. The random body is drawn from
// cryptographically secure bytes mapped onto a base62 alphabet, so the key is URL-safe and
// copy-paste friendly. Default length gives ~40 base62 chars (>200 bits) of entropy. The
// full key is returned to the caller exactly once; only its hash + prefix are ever stored.
export const generateApiKey = (length = 40): string => {
   const bytes = crypto.randomBytes(length);
   let body = '';
   for (let i = 0; i < length; i += 1) {
      body += BASE62[bytes[i] % BASE62.length];
   }
   return `s33k_${body}`;
};

// Mint an unguessable invite code. Same cryptographically-secure base62 body as an API key
// (>200 bits at the default length) but with no `s33k_` prefix, since the code is a one-time
// credential the public accept endpoint trades for a real key, not a key itself. It is stored
// in clear (single-use, short-lived) and looked up by exact, indexed match, so an invalid code
// is rejected fast without leaking whether any account or email exists.
export const generateInviteCode = (length = 40): string => {
   const bytes = crypto.randomBytes(length);
   let body = '';
   for (let i = 0; i < length; i += 1) {
      body += BASE62[bytes[i] % BASE62.length];
   }
   return body;
};

const resolveAccount = async (req: NextApiRequest, res: NextApiResponse): Promise<ResolvedAccount> => {
   const cookies = new Cookies(req, res);
   const token = cookies && cookies.get('token');

   // Cookie session: admin account in wave 1 (no users table yet).
   if (token && process.env.SECRET) {
      let valid = false;
      jwt.verify(token, process.env.SECRET, { algorithms: ['HS256'] }, (err) => { valid = !err; });
      if (valid) { return { authorized: true, account: adminAccount(), role: 'admin' }; }
   }

   const authHeader = req.headers.authorization;
   const bearer = authHeader ? authHeader.substring('Bearer '.length) : '';

   // Legacy global key always resolves to admin, regardless of the flag.
   if (bearer && bearer === process.env.APIKEY) {
      return { authorized: true, account: adminAccount(), role: 'admin' };
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
            // Surface the key's scoped_domain so authorize() can enforce the per-domain share
            // restriction. A normal key has null here (no restriction); a share key carries the
            // one domain it may read. Keys minted before the column existed read undefined,
            // which is treated as null (unrestricted), identical to today.
            const scopedDomain: string | null = candidate.scoped_domain ?? null;
            // Surface the key's role so authorize() can hold a member key to GET-only.
            // Legacy keys (and keys minted before the role column existed) default to admin.
            // A SHARE key (scopedDomain set) is forced to 'member' regardless of its stored role:
            // it is a read-only per-domain link and must never carry the admin role, even if it was
            // minted on the admin account (whose owned domains have owner_id null). We also stamp the
            // non-enumerable scoped marker so isAdminAccount() treats it as a non-admin everywhere,
            // closing the admin-identity-inheritance leak (defense in depth behind the route allowlist).
            const role: 'admin' | 'member' = (scopedDomain || candidate.role === 'member') ? 'member' : 'admin';
            if (scopedDomain) { markScopedAccount(account); }
            return { authorized: true, account, role, scopedDomain };
         }
      }
      return { authorized: false, account: null, error: 'Invalid API Key Provided.' };
   }

   return { authorized: false, account: null, error: 'Not authorized' };
};

export default resolveAccount;
