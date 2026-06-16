import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Account from '../../database/models/account';
import ApiKey from '../../database/models/apiKey';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { ADMIN_ACCOUNT_ID } from '../../utils/scope';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';

// API-key management. Minting an extra key (POST) and revoking a key (DELETE) is allowed
// for the admin account (any account_id) or for an account acting on ITS OWN keys. A
// non-admin account can never mint or revoke a key belonging to another account: that
// cross-account access is exactly the leak the multi-tenant work exists to prevent.
//
// Meaningful only with MULTI_TENANT on; with the flag off the only caller is the admin
// account, for which every check below passes trivially.

type KeyCreateRes = {
   apiKey?: string | null,
   keyId?: number | null,
   error?: string | null,
};

type KeyDeleteRes = {
   revoked?: boolean,
   error?: string | null,
};

const isAdmin = (account: Account | null | undefined): boolean => Boolean(account) && account!.ID === ADMIN_ACCOUNT_ID;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method === 'POST') {
      return mintKey(req, res, account);
   }
   if (req.method === 'DELETE') {
      return revokeKey(req, res, account);
   }
   return res.status(502).json({ error: 'Unrecognized Route.' });
}

const mintKey = async (req: NextApiRequest, res: NextApiResponse<KeyCreateRes>, account: Account | null) => {
   const { account_id: accountIdRaw, name } = req.body || {};
   const accountId = Number(accountIdRaw);
   if (!accountIdRaw || Number.isNaN(accountId)) {
      return res.status(400).json({ error: 'account_id is Required!' });
   }
   // Admin may mint for any account; a tenant may mint only for its own account.
   if (!isAdmin(account) && account!.ID !== accountId) {
      return res.status(403).json({ error: 'Cannot mint a key for another account.' });
   }
   try {
      const target = await Account.findOne({ where: { ID: accountId } });
      if (!target) {
         return res.status(404).json({ error: 'Account not found.' });
      }
      const fullKey = generateApiKey();
      const created = await ApiKey.create({
         account_id: accountId,
         name: name && typeof name === 'string' ? name.trim() : 'additional',
         key_prefix: apiKeyPrefix(fullKey),
         key_hash: hashApiKey(fullKey),
      });
      return res.status(201).json({ apiKey: fullKey, keyId: created.ID });
   } catch (error) {
      console.log('[ERROR] Minting API Key: ', error);
      return res.status(400).json({ error: 'Error Minting API Key.' });
   }
};

const revokeKey = async (req: NextApiRequest, res: NextApiResponse<KeyDeleteRes>, account: Account | null) => {
   const keyId = Number(req.query.id);
   if (!req.query.id || Number.isNaN(keyId)) {
      return res.status(400).json({ revoked: false, error: 'Key id is Required!' });
   }
   try {
      const key = await ApiKey.findOne({ where: { ID: keyId } });
      if (!key) {
         return res.status(404).json({ revoked: false, error: 'Key not found.' });
      }
      // Admin may revoke any key; a tenant may revoke only its own keys. We return 404
      // (not 403) when a tenant targets another account's key so existence is not leaked.
      if (!isAdmin(account) && account!.ID !== key.account_id) {
         return res.status(404).json({ revoked: false, error: 'Key not found.' });
      }
      key.revoked_at = new Date();
      await key.save();
      return res.status(200).json({ revoked: true });
   } catch (error) {
      console.log('[ERROR] Revoking API Key: ', error);
      return res.status(400).json({ revoked: false, error: 'Error Revoking API Key.' });
   }
};
