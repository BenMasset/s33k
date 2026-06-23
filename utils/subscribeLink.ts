import jwt from 'jsonwebtoken';
import type Account from '../database/models/account';

// A pre-authenticated, one-click "subscribe & continue" link. The trial-ended wall, the dashboard /
// start_here banners, and the trial-ending email all embed this URL so a user can pay from ANYWHERE
// (their LLM relays it, the email button is it, the app links to it) in ONE click, with NO login dance.
//
// HOW IT IS SAFE: the URL carries a SHORT-LIVED SIGNED JWT (HS256, keyed by the app SECRET) that names
// the account id and a 'checkout' purpose. /api/subscribe verifies the signature + expiry + purpose and
// only ever creates a checkout session for THE account named in the token. It cannot be forged without
// SECRET, and it cannot be retargeted at another tenant (the account id is inside the signed payload).
// Worst case if a link leaks: the finder could start a checkout for that account, which means PAYING
// for someone else's account with their own card. That is a gift, not an attack, so the risk is low;
// the token is still scoped + short-lived as defense in depth.

const PURPOSE = 'checkout';
// 14 days: the trial-ending email goes out ~3 days before expiry and the link must keep working through
// expiry and a short grace, but not forever. A user who lets it lapse simply gets a fresh link from the
// next wall hit or email.
const TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

type CheckoutTokenPayload = { accountId: number, purpose: string };

/** Mint a signed checkout token for an account, or null when SECRET / the account id is unavailable. */
export const mintSubscribeToken = (account: Account | null | undefined): string | null => {
   const secret = process.env.SECRET;
   const accountId = account ? account.ID : null;
   if (!secret || typeof accountId !== 'number' || !Number.isFinite(accountId)) { return null; }
   return jwt.sign({ accountId, purpose: PURPOSE }, secret, { expiresIn: TOKEN_TTL_SECONDS });
};

/** Verify a checkout token and return the account id it names, or null when invalid/expired/wrong-purpose. */
export const verifySubscribeToken = (token: string | null | undefined): number | null => {
   const secret = process.env.SECRET;
   if (!secret || !token) { return null; }
   try {
      // Pin the algorithm explicitly (HS256), matching utils/resolveAccount.ts + utils/verifyUser.ts.
      // Without this, verification trusts the token header's declared alg; jsonwebtoken v9 already
      // blocks the classic alg-confusion attacks, but on a public billing route the security property
      // must live in the code, not in a dependency default that a future bump could change.
      const payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as Partial<CheckoutTokenPayload>;
      if (payload && payload.purpose === PURPOSE && typeof payload.accountId === 'number' && Number.isFinite(payload.accountId)) {
         return payload.accountId;
      }
      return null;
   } catch {
      return null;
   }
};

/**
 * Build the one-click subscribe URL for an account, or null when a token cannot be minted (no SECRET).
 * The caller embeds it in a wall message, banner, or email. baseUrl must be the trusted public base
 * (resolveBaseUrl), never a request header, so the link cannot be host-poisoned.
 * @param {Account} account - the account the link should let subscribe.
 * @param {string} baseUrl - the trusted public base URL.
 * @returns {string | null} the absolute /api/subscribe?token=... URL, or null.
 */
export const subscribeUrl = (account: Account | null | undefined, baseUrl: string): string | null => {
   const token = mintSubscribeToken(account);
   if (!token) { return null; }
   return `${baseUrl.replace(/\/$/, '')}/api/subscribe?token=${encodeURIComponent(token)}`;
};

export default subscribeUrl;
