import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import ApiKey from '../../../database/models/apiKey';
import Invite from '../../../database/models/invite';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { generateApiKey, hashApiKey, apiKeyPrefix } from '../../../utils/resolveAccount';
import { resolveBaseUrl } from '../../../utils/baseUrl';
import { clientIp } from '../../../utils/collect-guards';
import { rateLimitAsync } from '../../../utils/rate-limit';
import { createTrialingAccount } from '../../../utils/provisionAccount';

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
//   Share invite    -> mint a read-only MEMBER key (role 'member') SCOPED to the invite's
//                      scoped_domain, on the invite's target_account_id (the domain owner's
//                      account). This is the mint-on-accept half of share-by-email: the share
//                      email carried only this activation link, never a key, so the scoped key
//                      first exists here, shown once, and is never stored in plaintext.
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

// Per-IP brute-force brake on probing the accept endpoint. Routed through the shared-store-capable
// limiter (rateLimitAsync + RATE_LIMIT_BACKEND='postgres') so the cap holds across instances under
// horizontal scaling, rather than becoming limit*N. The code entropy is still the primary control;
// this is defense in depth against rapid replay.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

// Client IP for the brute-force brake. Derived via the SHARED collect-guards.clientIp helper so
// both public-surface limiters key on the SAME trusted-hop logic: the rightmost (trusted-edge)
// X-Forwarded-For hop, never the spoofable leftmost one (audit area 1).
const ipFor = (req: NextApiRequest): string => clientIp(
   req.headers as Record<string, string | string[] | undefined>,
   req.socket?.remoteAddress,
);

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
   const ipBrake = await rateLimitAsync(`invite-accept-ip:${ipFor(req)}`, { limit: RATE_LIMIT_MAX, windowMs: RATE_LIMIT_WINDOW_MS });
   if (!ipBrake.allowed) {
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
      if (invite.type === 'share') {
         return acceptShare(req, res, invite);
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
const shareHint = (domain: string): string => 'Paste the command above into Claude Code. This is a read-only key '
   + `for ${domain} only: you can view its rankings, analytics, and AI visibility, but not make changes and not `
   + 'see any other site.';

// Apply the optional account display name from the accept body. createTrialingAccount sets a default
// name (the email, or 'New Account'); invite-accept additionally lets the recipient pass a name. We
// set it post-create when one was supplied so the shared mint stays the single source of the account
// shape and only this caller-specific touch lives here. Best-effort: a save failure must not undo a
// successful mint, so a name-save error is swallowed (the account + key already exist).
const applyAccountName = async (account: Account, name: string): Promise<void> => {
   if (!name || typeof account.save !== 'function') { return; }
   try {
      // Use the Sequelize instance setter (not a direct property assignment) so the field is staged
      // on the model the same way and we do not reassign the function parameter (no-param-reassign).
      account.set('name', name);
      await account.save();
   } catch (error) {
      console.log('[ERROR] Setting account name on accept: ', error);
   }
};

const acceptExternal = async (req: NextApiRequest, res: NextApiResponse<AcceptRes>, invite: Invite, name: string) => {
   // Claim the invite FIRST, before minting anything. If a concurrent request already claimed
   // it, the conditional update affects 0 rows and we reject generically with no side effects
   // (no orphaned account, no second key). This is the single-use guarantee on the mint path.
   if (!(await claimInvite(invite.ID))) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   // A new external admin gets a brand-new account and an admin key on it. acceptExternal is the
   // ONLY path that creates a NEW account, so it is the ONLY place a 14-day NO-credit-card trial
   // starts. Internal/share invites mint keys on an EXISTING account and never trial. We set
   // subscription_status 'trialing' + trial_ends_at = now + 14d; plan stays at its legacy default
   // and NO Stripe customer is created yet (no card is collected until the user runs Checkout).
   // These fields only matter with MULTI_TENANT on; with the flag off the admin is always active.
   //
   // We stamp account.email from the INVITE (never the request body) so the new account is later
   // findable by magic-link login. EMAIL-COLLISION EDGE CASE: account.email carries a UNIQUE index,
   // so if some account already holds invite.email the create would throw a unique-constraint error.
   // The invite is already claimed (single-use is preserved), so we MUST NOT fail the user here:
   // createAccount() retries WITHOUT the email on a unique-collision, so the signup still succeeds
   // and mints a working key. The new account simply has no email of its own, so the pre-existing
   // account that owns that email keeps the magic-link path (login is keyed to whoever holds the
   // email first). Better a usable key with no login-email than a 500 on a consumed invite.
   // Mint the trialing account via the SHARED core so invite-accept and public signup produce
   // byte-identical accounts (email encrypted at rest + blind-index hash, 14-day trial, the
   // unique-collision retry). The invite is already claimed (single-use preserved), so we MUST NOT
   // fail the user on a collision: createTrialingAccount retries WITHOUT the email in that case, so
   // the signup still succeeds with a working key (the account simply has no login-email of its own).
   // We stamp from invite.email (never the request body), then apply the optional display name.
   const account = await createTrialingAccount(invite.email || '');
   await applyAccountName(account, name);
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

// A share invite mints a read-only MEMBER key SCOPED to invite.scoped_domain, on the domain
// owner's account (invite.target_account_id), and returns it ONCE. This is the mint-on-accept
// half of share-by-email: the share email carried only the activation link, so the scoped key
// first comes into existence right here, is shown once, and only its prefix + hash are persisted.
// authorize() then holds the key to GET-only on exactly that one domain, identical to a key minted
// by /api/share directly. Mirrors acceptInternal: validate the target, claim atomically (single
// use), mint, stamp, reveal.
const acceptShare = async (req: NextApiRequest, res: NextApiResponse<AcceptRes>, invite: Invite) => {
   const targetId = invite.target_account_id;
   const scopedDomain = invite.scoped_domain;
   // A share invite must carry both the owner account to mint on and the domain to scope to. A
   // missing either (a malformed row) is a generic reject: never mint an UNSCOPED key.
   if (!targetId || !scopedDomain) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   // Confirm the owner account still exists and is active before minting. If not, generic reject
   // so we never leak which account ids exist.
   const target = await Account.findOne({ where: { ID: targetId } });
   if (!target || target.status !== 'active') {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   // Claim the invite atomically before minting. A concurrent replay flips 0 rows here and is
   // rejected, so a share link mints at most one scoped key.
   if (!(await claimInvite(invite.ID))) {
      return res.status(400).json({ error: GENERIC_REJECT });
   }
   const fullKey = generateApiKey();
   await ApiKey.create({
      account_id: target.ID,
      name: 'share',
      key_prefix: apiKeyPrefix(fullKey),
      key_hash: hashApiKey(fullKey),
      role: 'member',
      // scoped_domain is stored canonical by /api/share at invite-creation time, so it carries
      // straight onto the key and matches the authorize() canonicalized request gate.
      scoped_domain: scopedDomain,
   });
   await stampAcceptedBy(invite.ID, target.ID);
   return res.status(201).json({
      apiKey: fullKey,
      accountId: target.ID,
      role: 'member',
      mcpConfig: mcpFor(req, fullKey),
      mcpCommand: commandFor(req, fullKey),
      onboardingHint: shareHint(scopedDomain),
   });
};
