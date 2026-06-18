import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import ApiKey from '../../../database/models/apiKey';
import Invite from '../../../database/models/invite';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../../utils/resolveAccount';
import { resolveBaseUrl } from '../../../utils/baseUrl';
import { clientIp } from '../../../utils/collect-guards';

// PUBLIC invite-accept endpoint. This route takes NO API key: the invite code IS the
// credential. It is the one place outside the account-management routes that mints a real
// API key, so it is the most security-sensitive surface in the invite system. The defenses:
//
//   - Codes are long, random, single-use, and expirable (see utils/resolveAccount
//     generateInviteCode + the TTL below). Lookup is an exact, indexed match.
//   - An invalid / used / expired / revoked code is rejected fast with a SINGLE generic
//     message ('Invalid or expired invite code.'). We never reveal whether a code, account,
//     or email exists, so the endpoint cannot be used to enumerate anything.
//   - A lightweight per-IP rate limit caps how fast invalid codes can be probed. Codes are
//     ~200 bits of entropy, so this is defense in depth, not the primary control.
//   - Acceptance is single-use: the first successful accept flips status off 'pending', so a
//     replayed code falls straight into the generic-reject path.
//
//   External invite -> create a NEW admin account + mint an ADMIN key on it.
//   Internal invite -> mint a read-only MEMBER key (role 'member') on the invite's
//                      target_account_id (the inviting admin's account).
//
// The full API key is returned exactly once, with the MCP config the recipient needs to wire
// up their LLM client. Only the key's prefix + hash are ever persisted.

// Invites are short-lived. 30 days from creation, after which the code is treated as expired
// (and lazily flipped to status 'expired' on the next touch). No new column needed: we derive
// expiry from the timestamps-managed createdAt.
const INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// The single generic rejection. Used for invalid, missing, used, expired, and revoked codes so
// the response is indistinguishable across all of them: no existence is ever leaked.
const GENERIC_REJECT = 'Invalid or expired invite code.';

// Lightweight in-memory per-IP rate limiter. Process-local and best-effort (it resets on
// redeploy and is not shared across instances), which is acceptable: the real control is the
// code entropy. It exists to blunt rapid brute-force probing of the accept endpoint.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const attempts = new Map<string, { count: number, resetAt: number }>();

// Client IP for the brute-force brake. Derived via the SHARED collect-guards.clientIp helper so
// both public-surface limiters key on the SAME trusted-hop logic: the rightmost (trusted-edge)
// X-Forwarded-For hop, never the spoofable leftmost one (audit area 1).
const ipFor = (req: NextApiRequest): string => clientIp(
   req.headers as Record<string, string | string[] | undefined>,
   req.socket?.remoteAddress,
);

// Returns true when the caller is over the limit. Counts every attempt; a successful accept is
// rare and harmless to count. Opportunistically prunes the probed key when its window rolls.
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

type AcceptRes = {
   apiKey?: string,
   accountId?: number,
   role?: 'admin' | 'member',
   mcpConfig?: { S33K_BASE_URL: string, S33K_API_KEY: string },
   // The one-line hosted-MCP connect command (key embedded). This is the primary, zero-install
   // path the accept page leads with; mcpConfig is the manual fallback.
   mcpCommand?: string,
   onboardingHint?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<AcceptRes>) {
   await ensureSynced();
   await ensureAdminAccount();

   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   if (isRateLimited(ipFor(req))) {
      return res.status(429).json({ error: 'Too many attempts. Try again shortly.' });
   }

   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const code = typeof body.code === 'string' ? body.code.trim() : '';
   // Cap the account display name so an authed-context write cannot push an unbounded blob into
   // Account.name (audit area 1, low). A real name is short; 200 chars is generous.
   const name = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : '';

   // Reject an obviously malformed code fast, before any DB read, with the generic message.
   if (!code) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }

   try {
      const invite = await Invite.findOne({ where: { code } });
      // Unknown code: generic reject, no existence leak.
      if (!invite) {
         return res.status(400).json({ error: GENERIC_REJECT });
      }
      // Anything not currently pending (already accepted, revoked, expired) -> generic reject.
      if (invite.status !== 'pending') {
         return res.status(400).json({ error: GENERIC_REJECT });
      }
      // Expired by TTL: lazily flip status to 'expired' and reject generically.
      const createdAt = invite.get('createdAt') as Date | undefined;
      if (createdAt && Date.now() - new Date(createdAt).getTime() > INVITE_TTL_MS) {
         invite.status = 'expired';
         await invite.save();
         return res.status(400).json({ error: GENERIC_REJECT });
      }

      if (invite.type === 'external') {
         return acceptExternal(req, res, invite, name);
      }
      if (invite.type === 'internal') {
         return acceptInternal(req, res, invite);
      }
      // Unknown invite type should never happen; treat as a generic reject.
      return res.status(400).json({ error: GENERIC_REJECT });
   } catch (error) {
      console.log('[ERROR] Accepting Invite: ', error);
      return res.status(400).json({ error: 'Error Accepting Invite.' });
   }
}

// Atomically CLAIM an invite before any account/key is minted. The UPDATE is guarded by
// `status: 'pending'`, so it is a single conditional statement the database serializes: of N
// concurrent requests replaying the same code, exactly one flips the row (affected = 1) and the
// rest see affected = 0 and are rejected. This closes the check-then-act (TOCTOU) race on the
// single-use guarantee that a plain "read status, then update" would leave open on the
// key-minting path. We set accepted_by_account_id here too, before the account exists for an
// external invite, so it is patched in immediately after creation via stampAcceptedBy.
const claimInvite = async (inviteId: number): Promise<boolean> => {
   const [affected] = await Invite.update(
      { status: 'accepted', accepted_at: new Date() },
      { where: { ID: inviteId, status: 'pending' } },
   );
   return affected === 1;
};

// Record which account consumed the invite, once it is known. Separate from claimInvite because
// for an external invite the account does not exist until after the claim succeeds.
const stampAcceptedBy = async (inviteId: number, accountId: number): Promise<void> => {
   await Invite.update({ accepted_by_account_id: accountId }, { where: { ID: inviteId } });
};

const mcpFor = (req: NextApiRequest, fullKey: string) => ({
   S33K_BASE_URL: resolveBaseUrl(req),
   S33K_API_KEY: fullKey,
});

// The one-line, zero-install connect command: adds the hosted MCP endpoint with this key, so the
// recipient pastes it into Claude Code and is connected with no local server. mcpConfig is the
// manual fallback for self-hosters.
const commandFor = (req: NextApiRequest, fullKey: string): string => 'claude mcp add --transport http s33k '
   + `${resolveBaseUrl(req)}/api/mcp --header "Authorization: Bearer ${fullKey}"`;

const externalHint = 'Paste the command above into Claude Code, then ask s33k to onboard your domain to '
   + 'discover keywords and start tracking rankings.';
const internalHint = 'Paste the command above into Claude Code. This is a read-only member key: you can view '
   + 'rankings, analytics, and AI visibility, but not make changes.';

const acceptExternal = async (req: NextApiRequest, res: NextApiResponse<AcceptRes>, invite: Invite, name: string) => {
   // Claim the invite FIRST, before minting anything. If a concurrent request already claimed
   // it, the conditional update affects 0 rows and we reject generically with no side effects
   // (no orphaned account, no second key). This is the single-use guarantee on the mint path.
   if (!(await claimInvite(invite.ID))) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   // A new external admin gets a brand-new account and an admin key on it.
   const account = await Account.create({
      name: name || invite.email || 'New Account',
      plan: 'free',
      status: 'active',
   });
   const fullKey = generateApiKey();
   await ApiKey.create({
      account_id: account.ID,
      name: 'default',
      key_prefix: apiKeyPrefix(fullKey),
      key_hash: hashApiKey(fullKey),
      role: 'admin',
   });
   await stampAcceptedBy(invite.ID, account.ID);
   return res.status(201).json({
      apiKey: fullKey,
      accountId: account.ID,
      role: 'admin',
      mcpConfig: mcpFor(req, fullKey),
      mcpCommand: commandFor(req, fullKey),
      onboardingHint: externalHint,
   });
};

const acceptInternal = async (req: NextApiRequest, res: NextApiResponse<AcceptRes>, invite: Invite) => {
   // An internal invite joins an existing account as a read-only member. Confirm the target
   // account still exists and is active before minting the seat; if not, generic reject so we
   // do not leak which account ids exist.
   const targetId = invite.target_account_id;
   if (!targetId) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   const target = await Account.findOne({ where: { ID: targetId } });
   if (!target || target.status !== 'active') {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   // Claim the invite atomically before minting the member seat. A concurrent replay flips 0
   // rows here and is rejected, so an internal code mints at most one member key.
   if (!(await claimInvite(invite.ID))) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   const fullKey = generateApiKey();
   await ApiKey.create({
      account_id: target.ID,
      name: 'member',
      key_prefix: apiKeyPrefix(fullKey),
      key_hash: hashApiKey(fullKey),
      role: 'member',
   });
   await stampAcceptedBy(invite.ID, target.ID);
   return res.status(201).json({
      apiKey: fullKey,
      accountId: target.ID,
      role: 'member',
      mcpConfig: mcpFor(req, fullKey),
      mcpCommand: commandFor(req, fullKey),
      onboardingHint: internalHint,
   });
};
