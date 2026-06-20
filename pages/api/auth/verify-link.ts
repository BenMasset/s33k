import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import ApiKey from '../../../database/models/apiKey';
import Invite from '../../../database/models/invite';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../../utils/resolveAccount';
import { resolveBaseUrl } from '../../../utils/baseUrl';
import { isMultiTenantEnabled } from '../../../utils/scope';
import { clientIp } from '../../../utils/collect-guards';
import { LOGIN_TOKEN_TTL_MS } from './request-link';

// PUBLIC passwordless-login VERIFY endpoint. The other half of magic-link login: the user clicks the
// 15-minute link from their email, the page POSTs the token here, and we mint a FRESH api key on
// their existing account and return it ONCE. The token is the credential, exactly like the invite
// code at /api/invite/accept, so this route mirrors that route's defenses to the letter:
//
//   - GATED behind MULTI_TENANT. With the flag OFF this route HARD-REJECTS (404) and never touches
//     the DB; the single-admin instance keeps password login + the legacy APIKEY unchanged.
//   - GENERIC SINGLE REJECT ('Invalid or expired link.') for EVERY bad path: unknown token, used /
//     non-pending token, expired (>15m) token, a token of the WRONG type (anything but 'login', so
//     an external/internal/share invite code presented here is rejected), a revoked token, or a
//     malformed/empty body. Nothing distinguishes the cases: no existence of any token / account /
//     email is ever leaked.
//   - SHORT 15-minute TTL, re-checked here against the token's createdAt (and lazily flipped to
//     'expired'). The same TTL the request side stamped, kept in one place (request-link export).
//   - RACE-SAFE claim-before-mint: the token's status is atomically flipped pending -> used by a
//     guarded conditional UPDATE; of N concurrent redemptions of the same token exactly ONE flips
//     the row (affected === 1) and mints, the rest reject. Single key per token, guaranteed.
//   - On success it mints a NEW ADMIN api key on the token's account (a re-auth restores the
//     account's own admin access; it does NOT downgrade). OLD keys keep working until the user
//     revokes them: this is gradual key rotation, not forced rotation, so a returning user is not
//     locked out of an old device mid-flow.
//   - Per-IP rate limit, same brute-force brake as invite/accept.
//
// PUBLIC (pre-auth) like /api/invite/accept and POST /api/waitlist: takes NO Bearer key, so it is
// intentionally NOT added to utils/allowedApiRoutes.ts.

// The single generic rejection. Used for every bad-token path so they are indistinguishable.
const GENERIC_REJECT = 'Invalid or expired link.';

// Per-IP brute-force brake on token probing. Same shape as invite/accept. The token is >200 bits of
// entropy so this is defense in depth, not the primary control.
const RATE_LIMIT_MAX = (() => {
   const raw = parseInt(process.env.AUTH_VERIFY_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const attempts = new Map<string, { count: number, resetAt: number }>();

const ipFor = (req: NextApiRequest): string => clientIp(
   req.headers as Record<string, string | string[] | undefined>,
   req.socket?.remoteAddress,
);

const isRateLimited = (ip: string): boolean => {
   const now = Date.now();
   const entry = attempts.get(ip);
   if (!entry || entry.resetAt <= now) {
      attempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return false;
   }
   entry.count += 1;
   return entry.count > RATE_LIMIT_MAX;
};

// Atomically CLAIM a login token before any key is minted. The guarded conditional UPDATE (status
// pending -> used WHILE still pending) is serialized by the DB: of N concurrent redemptions exactly
// one flips the row (affected === 1) and mints, the rest see affected === 0 and reject. Closes the
// check-then-act (TOCTOU) race a plain "read status, then update" would leave open. We flip to
// 'used' (not 'accepted') so a login token's lifecycle reads distinctly from an invite's.
const claimLoginToken = async (tokenId: number): Promise<boolean> => {
   const [affected] = await Invite.update(
      { status: 'used', accepted_at: new Date() },
      { where: { ID: tokenId, status: 'pending', type: 'login' } },
   );
   return affected === 1;
};

type VerifyRes = {
   apiKey?: string,
   accountId?: number,
   role?: 'admin' | 'member',
   mcpConfig?: { S33K_BASE_URL: string, S33K_API_KEY: string },
   mcpCommand?: string,
   onboardingHint?: string,
   error?: string | null,
};

const mcpFor = (req: NextApiRequest, fullKey: string) => ({
   S33K_BASE_URL: resolveBaseUrl(req),
   S33K_API_KEY: fullKey,
});

const commandFor = (req: NextApiRequest, fullKey: string): string => 'claude mcp add --transport http s33k '
   + `${resolveBaseUrl(req)}/api/mcp --header "Authorization: Bearer ${fullKey}"`;

const loginHint = 'Paste the command above into Claude Code. This is a fresh key for your account; '
   + 'any keys you used before keep working until you revoke them.';

export default async function handler(req: NextApiRequest, res: NextApiResponse<VerifyRes>) {
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   // Feature gate: magic-link login only exists in the multi-tenant build. 404 + no DB touch when
   // the flag is off, so the single-admin password path is byte-for-byte unchanged.
   if (!isMultiTenantEnabled()) {
      return res.status(404).json({ error: 'Not found.' });
   }
   if (isRateLimited(ipFor(req))) {
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
   }

   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const token = typeof body.token === 'string' ? body.token.trim() : '';

   // Empty / malformed token: generic reject before any DB read.
   if (!token) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }

   try {
      await ensureSynced();
      await ensureAdminAccount();

      const loginToken = await Invite.findOne({ where: { code: token } });
      // Unknown token: generic reject, no existence leak.
      if (!loginToken) {
         return res.status(400).json({ error: GENERIC_REJECT });
      }
      // TYPE GUARD: only a 'login' token is redeemable here. An external/internal/share invite code
      // presented to this endpoint is rejected generically, and (symmetrically) a 'login' token is
      // not one of the types invite/accept handles, so it is rejected there too. The two credential
      // kinds never cross.
      if (loginToken.type !== 'login') {
         return res.status(400).json({ error: GENERIC_REJECT });
      }
      // Anything not currently pending (already used, revoked, expired): generic reject.
      if (loginToken.status !== 'pending') {
         return res.status(400).json({ error: GENERIC_REJECT });
      }
      // Expired by the 15-minute TTL: lazily flip status to 'expired' and reject generically.
      const createdAt = loginToken.get('createdAt') as Date | undefined;
      if (createdAt && Date.now() - new Date(createdAt).getTime() > LOGIN_TOKEN_TTL_MS) {
         loginToken.status = 'expired';
         await loginToken.save();
         return res.status(400).json({ error: GENERIC_REJECT });
      }

      // The account this token logs into. Confirm it still exists and is active BEFORE claiming, so
      // a token for a deactivated/deleted account rejects generically and never mints.
      const targetId = loginToken.target_account_id;
      if (!targetId) {
         return res.status(400).json({ error: GENERIC_REJECT });
      }
      const account = await Account.findOne({ where: { ID: targetId } });
      if (!account || account.status !== 'active') {
         return res.status(400).json({ error: GENERIC_REJECT });
      }

      // Claim the token atomically BEFORE minting. A concurrent redemption flips 0 rows here and is
      // rejected, so a login token mints AT MOST one key. Single-use on the mint path.
      if (!(await claimLoginToken(loginToken.ID))) {
         return res.status(400).json({ error: GENERIC_REJECT });
      }

      // Mint a FRESH ADMIN key on the account. Re-auth restores the account's own admin access; it
      // does not downgrade. Old keys are untouched (gradual rotation): the user can revoke them
      // from the account view if they want. Only the prefix + hash are persisted.
      const fullKey = generateApiKey();
      await ApiKey.create({
         account_id: account.ID,
         name: 'login',
         key_prefix: apiKeyPrefix(fullKey),
         key_hash: hashApiKey(fullKey),
         role: 'admin',
      });

      return res.status(201).json({
         apiKey: fullKey,
         accountId: account.ID,
         role: 'admin',
         mcpConfig: mcpFor(req, fullKey),
         mcpCommand: commandFor(req, fullKey),
         onboardingHint: loginHint,
      });
   } catch (error) {
      // A real DB/mint error is a controlled 4xx, never a 500, and never reveals which path failed.
      console.log('[ERROR] Verifying login link: ', error);
      return res.status(400).json({ error: GENERIC_REJECT });
   }
}
