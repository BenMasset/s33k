import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import ApiKey from '../../database/models/apiKey';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import resolveDomainAccess from '../../utils/domain-access';
import { resolveBaseUrl } from '../../utils/baseUrl';
import { sendInviteEmail } from '../../utils/send-invite';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../utils/resolveAccount';
import type Account from '../../database/models/account';

// Per-domain read-only SHARING.
//
// A "share" is a read-only API key minted on the domain OWNER's account but RESTRICTED to one
// domain via the api_key.scoped_domain column. Because the key lives on the owner's account,
// scopeWhere(owner) and every pillar query work UNCHANGED; the only new enforcement is the
// domain restriction, applied centrally in authorize() (GET-only AND req.query.domain must
// equal scoped_domain). This route is the management surface for those keys.
//
//   POST   /api/share { domain, email? }  - owner mints a read-only share key for an OWNED
//          domain. Returns the full key ONCE + an mcpConfig + a human instruction. If email is
//          given, best-effort sends the connect instructions (never blocks).
//   GET    /api/share?domain=...          - owner lists active+revoked shares for an OWNED domain.
//   DELETE /api/share?id=...              - owner revokes one share key, but ONLY a key whose
//          scoped_domain the caller OWNS. A foreign key returns 404 (no existence leak).
//
// Ownership is verified via resolveDomainAccess(account, domain, { write: true }) (the M1
// owner-only chokepoint), so a non-owner can never mint, list, or revoke a domain's shares.
// Meaningful only with MULTI_TENANT on; with the flag off the only caller is the admin account,
// for which the ownership gate resolves to a plain Domain.findOne and every check passes.

type ShareSummary = {
   ID: number,
   key_prefix: string,
   name: string | null,
   scoped_domain: string | null,
   created: string | null,
   last_used_at: string | null,
   revoked: boolean,
};

type ShareCreateRes = {
   apiKey?: string,
   keyId?: number,
   scopedDomain?: string,
   mcpConfig?: { S33K_BASE_URL: string, S33K_API_KEY: string },
   instruction?: string,
   emailSent?: boolean,
   error?: string | null,
};

type ShareListRes = {
   shares?: ShareSummary[],
   error?: string | null,
};

type ShareDeleteRes = {
   revoked?: boolean,
   error?: string | null,
};

const toSummary = (key: ApiKey): ShareSummary => ({
   ID: key.ID,
   key_prefix: key.key_prefix,
   name: key.name ?? null,
   scoped_domain: key.scoped_domain ?? null,
   created: key.get('createdAt') ? new Date(key.get('createdAt') as Date).toJSON() : null,
   last_used_at: key.last_used_at ? new Date(key.last_used_at).toJSON() : null,
   revoked: Boolean(key.revoked_at),
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method === 'POST') {
      return createShare(req, res, account);
   }
   if (req.method === 'GET') {
      return listShares(req, res, account);
   }
   if (req.method === 'DELETE') {
      return revokeShare(req, res, account);
   }
   return res.status(405).json({ error: 'Method Not Allowed. Use POST, GET, or DELETE.' });
}

const createShare = async (req: NextApiRequest, res: NextApiResponse<ShareCreateRes>, account: Account) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   const email = typeof body.email === 'string' ? body.email.trim() : '';
   if (!domain) {
      return res.status(400).json({ error: 'domain is Required!' });
   }

   // Owner-only: the caller must OWN this domain to share it. A non-owner (or a non-existent
   // domain) resolves to null and is denied with 403, never leaking whether the domain exists.
   const owned = await resolveDomainAccess(account, domain, { write: true });
   if (!owned) {
      return res.status(403).json({ error: 'You do not own this domain.' });
   }

   try {
      // Mint the share key ON THE OWNER's account (owned.owner_id when set, else the caller's
      // own account: that covers an admin-owned domain whose owner_id is null). The key is a
      // read-only member key scoped to this one domain.
      const ownerAccountId = (owned.owner_id ?? account.ID) as number;
      const fullKey = generateApiKey();
      // Store the scoped_domain in CANONICAL form so the authorize() gate (which canonicalizes
      // req.query.domain) can never be defeated by a non-canonical stored value. If scoped_domain
      // were stored as e.g. "www.example.com", a request for "www.example.com" would canonicalize
      // to "example.com" on the request side but compare against a raw "www.example.com" scoped
      // value, opening exactly the mismatch this feature must avoid. We use the resolved row's own
      // canonical domain (owned.domain is already canonical now that registration canonicalizes),
      // so the stored scope, the gate, the access grant, and list/revoke all share one normal form.
      const canonicalDomain = owned.domain;
      const created = await ApiKey.create({
         account_id: ownerAccountId,
         name: email ? `share:${email}` : 'share',
         key_prefix: apiKeyPrefix(fullKey),
         key_hash: hashApiKey(fullKey),
         role: 'member',
         scoped_domain: canonicalDomain,
      });

      const baseUrl = resolveBaseUrl(req);
      const mcpConfig = { S33K_BASE_URL: baseUrl, S33K_API_KEY: fullKey };
      // The zero-install connect path: one line adds the hosted MCP endpoint with this key, so the
      // recipient pastes it into their LLM client and is done (no local server). The manual
      // S33K_BASE_URL / S33K_API_KEY env pair stays as the fallback for self-hosters.
      const connectCommand = `claude mcp add --transport http s33k ${baseUrl}/api/mcp `
         + `--header "Authorization: Bearer ${fullKey}"`;
      const instruction = `Read-only access to ${canonicalDomain} on s33k. Connect in one line: ${connectCommand} `
         + `Or set S33K_BASE_URL=${baseUrl} and S33K_API_KEY=<the key above> in your MCP client. This key can `
         + `only read ${canonicalDomain}.`;

      // Best-effort email; if Resend is unconfigured or fails, the caller keeps the returned key
      // and instruction and we never fail the share for it. The email is self-contained: it carries
      // the one-line connect command (key embedded) so the recipient does not need anything else.
      let emailSent = false;
      if (email) {
         const result = await sendInviteEmail({
            to: email,
            acceptLink: baseUrl,
            type: 'share',
            inviterName: account.name,
            domain,
            connect: { command: connectCommand, baseUrl, apiKey: fullKey },
         });
         emailSent = result.sent;
      }

      return res.status(201).json({
         apiKey: fullKey,
         keyId: created.ID,
         scopedDomain: canonicalDomain,
         mcpConfig,
         instruction,
         emailSent,
      });
   } catch (error) {
      console.log('[ERROR] Creating Share: ', error);
      return res.status(400).json({ error: 'Error Creating Share.' });
   }
};

const listShares = async (req: NextApiRequest, res: NextApiResponse<ShareListRes>, account: Account) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain.trim() : '';
   if (!domain) {
      return res.status(400).json({ error: 'domain is Required!' });
   }
   // Owner-only read gate. A non-owner is denied; null never leaks domain existence.
   const owned = await resolveDomainAccess(account, domain, { write: true });
   if (!owned) {
      return res.status(403).json({ error: 'You do not own this domain.' });
   }
   try {
      // Query scoped_domain by the CANONICAL form, because mint stores scoped_domain canonical
      // (createShare above). Matching the raw ?domain= here would miss every share whenever the
      // caller passes a non-canonical variant ("WWW.example.com" vs the stored "example.com"),
      // making list/revoke inconsistent with mint. Resolve off the owned row's canonical domain.
      const shares = await ApiKey.findAll({
         where: { scoped_domain: owned.domain },
         order: [['ID', 'DESC']],
      });
      return res.status(200).json({ shares: shares.map(toSummary) });
   } catch (error) {
      console.log('[ERROR] Listing Shares: ', error);
      return res.status(400).json({ error: 'Error Listing Shares.' });
   }
};

const revokeShare = async (req: NextApiRequest, res: NextApiResponse<ShareDeleteRes>, account: Account) => {
   const keyId = Number(req.query.id);
   if (!req.query.id || Number.isNaN(keyId)) {
      return res.status(400).json({ revoked: false, error: 'Share id is Required!' });
   }
   try {
      const key = await ApiKey.findOne({ where: { ID: keyId } });
      // Only a SHARE key (scoped_domain set) is revocable here, and ONLY when the caller OWNS
      // its scoped domain. Anything else (no key, a non-share key, or a key scoped to a domain
      // the caller does not own) returns 404 so a tenant cannot probe key ids or domain names.
      if (!key || !key.scoped_domain) {
         return res.status(404).json({ revoked: false, error: 'Share not found.' });
      }
      const owned = await resolveDomainAccess(account, key.scoped_domain, { write: true });
      if (!owned) {
         return res.status(404).json({ revoked: false, error: 'Share not found.' });
      }
      key.revoked_at = new Date();
      await key.save();
      return res.status(200).json({ revoked: true });
   } catch (error) {
      console.log('[ERROR] Revoking Share: ', error);
      return res.status(400).json({ revoked: false, error: 'Error Revoking Share.' });
   }
};
