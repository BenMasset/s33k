import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { isMultiTenantEnabled } from '../../../utils/scope';
import { clientIp } from '../../../utils/collect-guards';
import { emailHash } from '../../../utils/accountEmail';
import { rateLimitAsync } from '../../../utils/rate-limit';
import { sendLoginLink, LOGIN_TOKEN_TTL_MS as SHARED_LOGIN_TOKEN_TTL_MS } from '../../../utils/sendLoginLink';

// PUBLIC passwordless-login REQUEST endpoint. A returning user who has an account but no key on
// THIS device POSTs their email; if the email maps to an account we mail a one-time, 15-minute
// login link that the verify endpoint trades for a FRESH api key. This route mints NO key itself.
//
// It is the email-facing half of magic-link login and is the highest-stakes pre-auth write after
// invite/accept, so it mirrors that route's defenses exactly:
//   - GATED behind MULTI_TENANT. With the flag OFF the single-admin instance still uses PASSWORD
//     login (/api/login) + the legacy APIKEY, so this route HARD-REJECTS (404) when the flag is off
//     and never touches the DB. Nothing here changes the single-admin path.
//   - NON-LEAK: whether or not the email maps to an account, the response is the IDENTICAL success
//     shape ({ sent: true }). A token is created and an email is sent ONLY when an account exists,
//     but the caller cannot tell the two cases apart, so the endpoint cannot enumerate accounts.
//   - PER-IP rate limit (blunt a flood of requests) AND PER-EMAIL rate limit (so an attacker cannot
//     spam a victim's inbox with login links). Both run BEFORE the account lookup, so the work and
//     the response shape are identical regardless of whether the account exists.
//   - The login token is a single-use Invite row of type 'login' with a SHORT 15-minute TTL (vs the
//     30-day invite TTL), target_account_id = the account. The verify endpoint enforces the TTL,
//     the single-use claim-before-mint, and the type guard (a 'login' token is only acceptable at
//     /api/auth/verify-link, never at /api/invite/accept, and vice versa).
//   - The email send is best-effort: a missing RESEND_API_KEY or a send failure never changes the
//     response and never throws.
//
// This route is PUBLIC (pre-auth, like /api/invite/accept and POST /api/waitlist): it takes NO
// Bearer key, so it is intentionally NOT added to utils/allowedApiRoutes.ts (that whitelist gates
// API-KEY callers; a route reached without a key is not on it).

// Hard email length cap (RFC 5321), mirroring the waitlist public-write cap.
const MAX_EMAIL_LEN = 254;

// Per-IP request brake on the open POST, same shape as waitlist/collect. Bounds how fast one source
// can probe or flood. Overridable via env. IP is the trusted-edge XFF hop (collect-guards.clientIp).
const REQUEST_RATE_LIMIT_MAX = (() => {
   const raw = parseInt(process.env.AUTH_REQUEST_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();
const REQUEST_RATE_WINDOW_MS = 60 * 1000;

// Per-EMAIL brake: at most this many login links per email per hour, so an attacker cannot flood a
// victim's inbox even from many IPs. Keyed on the normalized email, not the IP. This is the brake
// that degrades WORST under horizontal scaling (limit*N), so it is now routed through the shared-store
// limiter (rateLimitAsync + RATE_LIMIT_BACKEND='postgres') so the 3/hour cap holds across instances.
const EMAIL_RATE_LIMIT_MAX = (() => {
   const raw = parseInt(process.env.AUTH_EMAIL_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 3;
})();
const EMAIL_RATE_WINDOW_MS = 60 * 60 * 1000;

const ipFor = (req: NextApiRequest): string => clientIp(
   req.headers as Record<string, string | string[] | undefined>,
   req.socket?.remoteAddress,
);

// Permissive email sanity check (not deliverability), same as waitlist. A clearly-not-an-email
// value is rejected before any rate-limit/DB work.
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

// The single non-leak success response: returned whether or not the email maps to an account.
const SENT_OK = { sent: true } as const;

// 15-minute TTL for a login token. The value now lives in utils/sendLoginLink (the shared issue
// core); re-exported here so verify-link.ts keeps importing it from this module unchanged, and so
// the TTL has a SINGLE source the issuer and the verifier share and cannot drift.
export const LOGIN_TOKEN_TTL_MS = SHARED_LOGIN_TOKEN_TTL_MS;

type RequestLinkRes = {
   sent?: boolean,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<RequestLinkRes>) {
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   // Feature gate: magic-link login only exists in the multi-tenant build. With the flag off the
   // single-admin instance uses password login + the legacy APIKEY, so this route does not exist.
   // 404 (not 403) so an attacker cannot even distinguish "off" from "no such route". No DB touch.
   if (!isMultiTenantEnabled()) {
      return res.status(404).json({ error: 'Not found.' });
   }

   // Per-IP brake FIRST, before any parsing or DB work, so a flood is cheapest to reject. Routed
   // through the shared-store-capable limiter so the cap holds across instances when configured.
   const ipBrake = await rateLimitAsync(`auth-req-ip:${ipFor(req)}`, { limit: REQUEST_RATE_LIMIT_MAX, windowMs: REQUEST_RATE_WINDOW_MS });
   if (!ipBrake.allowed) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
   }

   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const email = typeof body.email === 'string'
      ? body.email.trim().toLowerCase().slice(0, MAX_EMAIL_LEN)
      : '';

   // A malformed email is rejected with the same generic non-leak shape: we do not confirm or deny
   // anything about accounts. (We could 400 here, but returning SENT_OK keeps the surface uniform.)
   if (!email || !looksLikeEmail(email)) {
      return res.status(200).json(SENT_OK);
   }

   // Per-EMAIL brake: bound how many links one inbox can be sent per hour, independent of IP. Runs
   // before the lookup so the amount of work is identical whether or not the account exists. Keyed on
   // the normalized email so the shared-store counter is the SAME row across every instance: the
   // 3/hour cap holds globally, closing the 3*N inbox-flood the per-process limiter left open.
   const emailBrake = await rateLimitAsync(`auth-req-email:${email}`, { limit: EMAIL_RATE_LIMIT_MAX, windowMs: EMAIL_RATE_WINDOW_MS });
   if (!emailBrake.allowed) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
   }

   try {
      await ensureSynced();
      await ensureAdminAccount();

      // Look the account up by the DETERMINISTIC email_hash blind index, not the plaintext email:
      // account.email is now the cryptr ciphertext (random IV, non-deterministic), so it cannot be
      // queried; email_hash = HMAC-SHA256(SECRET, normalized email) is stable and is the lookup key.
      // If none matches, we STILL return SENT_OK below without creating a token or sending mail: the
      // response is indistinguishable from the account-exists path (no enumeration).
      const account = await Account.findOne({ where: { email_hash: emailHash(email) } });

      if (account && account.status === 'active') {
         // Mint the single-use, 15-minute login token + fire the magic-link email via the SHARED
         // issue core (utils/sendLoginLink), the same one public signup uses, so the two send an
         // identical login link. The token is an Invite of type 'login' (reuses the single-use +
         // claim-before-mint machinery, type-guarded to verify-link); the send is fired-not-awaited
         // inside sendLoginLink as the timing-oracle fix, so the account-exists path is no slower
         // than the no-account path. Never throws (best-effort send), so the uniform response holds.
         await sendLoginLink(req, account, email);
      }

      // Identical response whether or not the account existed. No existence leak.
      return res.status(200).json(SENT_OK);
   } catch (error) {
      // Never 500 and never leak: on any DB/send error, return the SAME success shape. An attacker
      // must not be able to tell an error apart from a no-account case. We log for operators.
      console.log('[ERROR] Requesting login link: ', error);
      return res.status(200).json(SENT_OK);
   }
}
