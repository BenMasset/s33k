import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Account from '../../database/models/account';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { isMultiTenantEnabled } from '../../utils/scope';
import { clientIp } from '../../utils/collect-guards';
import { emailHash } from '../../utils/accountEmail';
import { rateLimitAsync } from '../../utils/rate-limit';
import { createTrialingAccount } from '../../utils/provisionAccount';
import { sendLoginLink } from '../../utils/sendLoginLink';

// PUBLIC, email-verified, self-serve SIGNUP. A stranger with no invite POSTs their email here; if it
// is NEW we mint a TRIALING account (identical to the invite-accept path, via the shared
// createTrialingAccount core) and email a magic login link. The user clicks the link -> /auth/login
// -> /api/auth/verify-link mints their first API key. So signup is email-verified BY CONSTRUCTION:
// no key is ever returned from this route, and an account only becomes usable once its owner proves
// control of the inbox by clicking the link. This is the open front door that replaces invite-only.
//
// It is a pre-account public write, so it mirrors pages/api/waitlist.ts's defenses EXACTLY:
//   - GATED behind MULTI_TENANT. With the flag OFF the single-admin instance uses password login +
//     the legacy APIKEY and there is no public signup, so this route HARD-REJECTS 404 and never
//     touches the DB. Nothing here changes the single-tenant / flag-off path.
//   - CORS allowlist (WAITLIST_ALLOWED_ORIGINS, same env as waitlist) so the s33k.io landing can POST
//     cross-origin; the browser preflight (OPTIONS) is answered 204 before any work.
//   - PER-IP rate limit (blunt a flood) AND PER-EMAIL rate limit (so an attacker cannot mint accounts
//     / spam a victim's inbox with login links), both via the shared-store-capable limiter.
//   - Email length cap (RFC 5321) + a permissive looksLikeEmail sanity check.
//   - NON-LEAK (RESPONSE shape): whether the email is new or already held by an account, the response
//     is the IDENTICAL { sent: true }. A NEW email mints + sends; an EXISTING email does NOTHING
//     observable in the body. NOTE the honest residual: the new-email branch does extra awaited DB
//     writes (createTrialingAccount + the login-token Invite.create) that the existing-email branch
//     skips, so the two branches differ by a few ms of local DB-write latency. The Resend send is
//     fired-not-awaited (removing the dominant hundreds-of-ms leak), and the per-email 3/hour +
//     per-IP 10/min caps make a statistical timing attack impractical, but this is NOT a proven
//     constant-time endpoint: do not treat new-vs-existing as cryptographically indistinguishable.
//     The durable fix (equalize the awaited work on both branches, shared with request-link) is a
//     tracked should-fix, not done here.
//
// Like /api/waitlist and /api/auth/request-link, this route is reached WITHOUT a Bearer key, so it is
// intentionally NOT in utils/allowedApiRoutes.ts (that whitelist gates API-KEY callers).

// Hard email length cap (RFC 5321), mirroring the waitlist + request-link public-write caps.
const MAX_EMAIL_LEN = 254;

// Per-IP request brake on the open POST. Bounds how fast one source can mint accounts / probe.
// Overridable via env. IP is the trusted-edge XFF hop (collect-guards.clientIp).
const SIGNUP_IP_RATE_LIMIT = (() => {
   const raw = parseInt(process.env.SIGNUP_IP_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();
const SIGNUP_IP_RATE_WINDOW_MS = 60 * 1000;

// Per-EMAIL brake: at most this many signups per email per hour, so an attacker cannot flood a
// victim's inbox with login links even from rotating IPs. Keyed on the normalized email. Routed
// through the shared-store limiter so the cap holds across instances (3/hour TOTAL, not 3*N).
const SIGNUP_EMAIL_RATE_LIMIT = (() => {
   const raw = parseInt(process.env.SIGNUP_EMAIL_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();
const SIGNUP_EMAIL_RATE_WINDOW_MS = 60 * 60 * 1000;

const ipFor = (req: NextApiRequest): string => clientIp(
   req.headers as Record<string, string | string[] | undefined>,
   req.socket?.remoteAddress,
);

// Permissive email sanity check (not deliverability), same as waitlist / request-link.
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// The single non-leak success response: returned whether the email is new or already held.
const SENT_OK = { sent: true } as const;

type SignupRes = {
   sent?: boolean,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<SignupRes>) {
   // CORS for the PUBLIC signup form posting cross-origin from the s33k.io landing site. Same env +
   // allowlist as waitlist: echo only an allowlisted Origin, answer the preflight 204 before any work.
   const allowedOrigins = (process.env.WAITLIST_ALLOWED_ORIGINS
      || 'https://s33k.io,https://www.s33k.io,https://app.s33k.io')
      .split(',').map((o) => o.trim()).filter(Boolean);
   const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
   if (origin && allowedOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '86400');
   }
   if (req.method === 'OPTIONS') {
      return res.status(204).end();
   }

   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }

   // Feature gate: public signup only exists in the multi-tenant build. With the flag off the
   // single-admin instance has no public account creation, so the route does not exist. 404 (not 403)
   // so an attacker cannot distinguish "off" from "no such route". No DB touch on the flag-off path.
   if (!isMultiTenantEnabled()) {
      return res.status(404).json({ error: 'Not found.' });
   }

   // Per-IP brake FIRST, before any parsing or DB work, so a flood is cheapest to reject.
   const ipBrake = await rateLimitAsync(`signup-ip:${ipFor(req)}`, { limit: SIGNUP_IP_RATE_LIMIT, windowMs: SIGNUP_IP_RATE_WINDOW_MS });
   if (!ipBrake.allowed) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
   }

   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const email = typeof body.email === 'string'
      ? body.email.trim().toLowerCase().slice(0, MAX_EMAIL_LEN)
      : '';

   // A malformed email returns the same generic non-leak shape: we confirm or deny nothing.
   if (!email || !looksLikeEmail(email)) {
      return res.status(200).json(SENT_OK);
   }

   // Per-EMAIL brake: bound how many signups one inbox can trigger per hour, independent of IP. Runs
   // before the lookup so the amount of work is identical whether the account exists or not, keyed on
   // the normalized email so the shared-store counter holds globally across instances.
   const emailBrake = await rateLimitAsync(`signup-email:${email}`, { limit: SIGNUP_EMAIL_RATE_LIMIT, windowMs: SIGNUP_EMAIL_RATE_WINDOW_MS });
   if (!emailBrake.allowed) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
   }

   try {
      await ensureSynced();
      await ensureAdminAccount();

      // Look up by the deterministic email_hash blind index (account.email is the non-deterministic
      // ciphertext and cannot be queried). If an account ALREADY holds this email, do NOTHING
      // observable: no second account, no email. We still fall through to the identical SENT_OK below,
      // so the response is indistinguishable from the new-email path (no enumeration).
      const existing = await Account.findOne({ where: { email_hash: emailHash(email) } });

      if (!existing) {
         // NEW email: mint the trialing account via the shared core (byte-identical to invite-accept),
         // then issue + send the magic login link. No key is returned here: the user proves inbox
         // control by clicking the link, which mints their first key at verify-link. createTrialingAccount
         // is race-safe on a unique collision (it retries without the email), so a concurrent duplicate
         // signup never 500s; sendLoginLink fires the email best-effort (never throws, not awaited inside).
         const account = await createTrialingAccount(email);
         await sendLoginLink(req, account, email);
      }

      // Identical response whether the email was new or already held. No existence leak.
      return res.status(200).json(SENT_OK);
   } catch (error) {
      // Never 500 and never leak: on any DB / send error, return the SAME success shape so an attacker
      // cannot tell an error apart from a no-op. We log for operators.
      console.log('[ERROR] Signup: ', error);
      return res.status(200).json(SENT_OK);
   }
}
