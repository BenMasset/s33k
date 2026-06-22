import type { NextApiRequest } from 'next';
import Invite from '../database/models/invite';
import { generateInviteCode } from './resolveAccount';
import { resolveBaseUrl } from './baseUrl';
import { sendMagicLinkEmail } from './send-invite';
import type Account from '../database/models/account';

// sendLoginLink is the SHARED magic-link issue + send core. It mints a single-use, short-lived
// 'login' token (an Invite row of type 'login') targeting the given account, then FIRES (does NOT
// await) the Resend magic-link email. It is called by BOTH the returning-user login path
// (pages/api/auth/request-link.ts) and the new public signup path (pages/api/signup.ts), so a fresh
// signup and a returning login send the SAME verified login link the verify endpoint trades for a
// fresh API key. Extracting it here keeps the token shape + timing-oracle fix in one place so the
// two callers cannot drift.
//
// The not-awaited send is a deliberate timing-oracle fix carried over from request-link: awaiting
// the outbound HTTPS call before the caller responds would make an account-exists path measurably
// slower than a no-account path, leaking email existence. We persist the token (awaited) and kick
// the send off; the link works the moment the email arrives. A missing RESEND_API_KEY or a send
// failure never throws (best-effort helper) and never changes the caller's response.

// 15-minute TTL for a login token. Far shorter than the 30-day invite TTL: a login link should be
// usable promptly and then dead. The verify endpoint re-checks this same window. Exported so a
// single source of the value is shared (request-link re-exports it for back-compat).
export const LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

// Mints the single-use 'login' token for `account` and fires the magic-link email to `email`. The
// req is used only to resolve the user-facing base URL for the login link. Resolves to void: the
// token create is awaited (so the link is valid the instant the email lands), the send is not.
//
// API CONTRACT (other agents / callers depend on this exact shape):
//   export sendLoginLink(account: Account, email: string): Promise<void>
export const sendLoginLink = async (req: NextApiRequest, account: Account, email: string): Promise<void> => {
   // The login token reuses the proven single-use + claim-before-mint Invite machinery, but the
   // verify endpoint's type guard ensures a 'login' token is ONLY redeemable at /api/auth/verify-link,
   // never at /api/invite/accept. The token is self-issued by the user; there is no inviter, so we
   // stamp the account's own id for FK-consistent attribution.
   const code = generateInviteCode();
   await Invite.create({
      code,
      inviter_account_id: account.ID,
      type: 'login',
      email,
      target_account_id: account.ID,
      status: 'pending',
   });

   const loginLink = `${resolveBaseUrl(req)}/auth/login?token=${code}`;
   // Best-effort send, FIRED AND NOT AWAITED (timing-oracle fix, see header). The token row is
   // already persisted above, so the link works the moment the email arrives.
   sendMagicLinkEmail({ to: email, loginLink }).catch((e) => {
      console.log('[ERROR] Sending magic link: ', e);
   });
};

export default sendLoginLink;
