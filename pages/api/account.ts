import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Account from '../../database/models/account';
import ApiKey from '../../database/models/apiKey';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { isAdminAccount, ADMIN_ACCOUNT_ID } from '../../utils/scope';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
import { recordAudit } from '../../utils/auditLog';

// Account-management routes. These are ADMIN-only: only the seeded admin account
// (account.ID === ADMIN_ACCOUNT_ID) may create or list accounts. They are meaningful only
// with MULTI_TENANT on (they are the hooks the invite + onboarding systems call to mint a
// tenant and its first key) but must not break with the flag off. With the flag off the
// only caller that ever reaches here is the admin account, so the admin gate is a no-op.

type AccountSummary = {
   ID: number,
   name: string,
   plan: string,
   status: string,
   keyCount?: number,
   lastUsed?: string | null,
};

type AccountCreateRes = {
   account?: AccountSummary | null,
   apiKey?: string | null,
   error?: string | null,
};

type AccountListRes = {
   accounts?: AccountSummary[],
   error?: string | null,
};

// Admin gate routes through isAdminAccount (utils/scope.ts): the admin sentinel id, but NEVER a
// scoped share-key account (which can be minted on the admin account and would otherwise inherit
// admin rights). Belt: the share-key route allowlist already denies this route entirely.
const isAdmin = isAdminAccount;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (!isAdmin(account)) {
      return res.status(403).json({ error: 'Admin access required.' });
   }
   const actorId = account ? account.ID : ADMIN_ACCOUNT_ID;
   if (req.method === 'POST') {
      return createAccount(req, res, actorId);
   }
   if (req.method === 'GET') {
      return listAccounts(req, res, actorId);
   }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const createAccount = async (req: NextApiRequest, res: NextApiResponse<AccountCreateRes>, actorId: number) => {
   const { name, plan } = req.body || {};
   if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Account name is Required!' });
   }
   try {
      const newAccount = await Account.create({
         name: name.trim(),
         plan: plan && typeof plan === 'string' ? plan.trim() : 'free',
         status: 'active',
      });

      // Mint the account's first key. The full key is returned to the caller exactly once;
      // we persist only its prefix (for lookup) and SHA-256 hash, never the clear value.
      const fullKey = generateApiKey();
      await ApiKey.create({
         account_id: newAccount.ID,
         name: 'default',
         key_prefix: apiKeyPrefix(fullKey),
         key_hash: hashApiKey(fullKey),
      });

      // Privileged instance action: the operator created a new tenant account + first key. Audit it
      // (metadata only). Best-effort, never blocks the response (recordAudit cannot throw).
      await recordAudit({
         actorAccountId: actorId,
         actorRole: 'admin',
         action: 'account.create',
         targetAccountId: newAccount.ID,
         route: '/api/account',
      });
      const summary: AccountSummary = {
         ID: newAccount.ID, name: newAccount.name, plan: newAccount.plan, status: newAccount.status,
      };
      return res.status(201).json({ account: summary, apiKey: fullKey });
   } catch (error) {
      console.log('[ERROR] Creating Account: ', error);
      return res.status(400).json({ error: 'Error Creating Account.' });
   }
};

// listAccounts returns ACCOUNT METADATA ONLY (id, name, plan, status, key count, last-used). It
// queries ONLY the Account and ApiKey tables, NEVER tenant-content tables (Keyword, S33kEvent,
// CrawlerHit, Domain rankings): the operator's instance-admin privilege exposes who the tenants are,
// never what their data is. Keep it that way; do not add a tenant-content read here.
const listAccounts = async (req: NextApiRequest, res: NextApiResponse<AccountListRes>, actorId: number) => {
   try {
      const accounts = await Account.findAll();
      const keys = await ApiKey.findAll({ where: { revoked_at: null } });
      // Privileged instance action: the operator listed all tenant accounts (metadata). Audit it.
      await recordAudit({
         actorAccountId: actorId, actorRole: 'admin', action: 'account.list', route: '/api/account',
      });
      const summaries: AccountSummary[] = accounts.map((acc) => {
         const accountKeys = keys.filter((k) => k.account_id === acc.ID);
         const lastUsedDates = accountKeys
            .map((k) => k.last_used_at)
            .filter((d): d is Date => Boolean(d))
            .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
         return {
            ID: acc.ID,
            name: acc.name,
            plan: acc.plan,
            status: acc.status,
            keyCount: accountKeys.length,
            lastUsed: lastUsedDates.length > 0 ? new Date(lastUsedDates[0]).toJSON() : null,
         };
      });
      return res.status(200).json({ accounts: summaries });
   } catch (error) {
      console.log('[ERROR] Listing Accounts: ', error);
      return res.status(400).json({ error: 'Error Listing Accounts.' });
   }
};
