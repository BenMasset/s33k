import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Account from '../../database/models/account';
import { resolveBaseUrl } from '../../utils/baseUrl';
import { verifySubscribeToken } from '../../utils/subscribeLink';
import { createCheckoutSession } from '../../utils/billing-checkout';
import { rateLimit } from '../../utils/rate-limit';
import { clientIp } from '../../utils/collect-guards';

// GET /api/subscribe?token=<signed checkout token> -> 302 redirect to the Stripe Checkout page.
//
// The ONE-CLICK, pre-authenticated pay link. A trial-ended user (in their LLM, the dunning email, or
// the app) clicks this and lands straight on Stripe Checkout, no login. It is PUBLIC (no API key):
// the signed JWT in ?token= is the credential. We verify the token (utils/subscribeLink), resolve the
// account it names, and create a checkout session for THAT account only via the shared
// createCheckoutSession. It is intentionally NOT in allowedApiRoutes.ts (that whitelist gates
// API-KEY callers); like the Stripe webhook + the auth magic-link routes, this is a public route
// secured by a verifiable signed token, not the key whitelist.
//
// Every failure (missing/invalid/expired token, unknown account, billing not configured, Stripe
// error, already-active account) ends in a friendly redirect to /welcome, never a raw error page or a
// 500, so a stale link is a soft landing. Defaults to 1 site (the "continue my account" case); the
// user can add more sites later from the billing portal / start_checkout.

const redirectToWelcome = (res: NextApiResponse, baseUrl: string, reason: string): void => {
   res.redirect(302, `${baseUrl}/welcome?billing=${reason}`);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   const baseUrl = resolveBaseUrl(req);
   if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return redirectToWelcome(res, baseUrl, 'error');
   }

   // Light per-IP brake: a valid token is required to do anything, but bound how fast one source can
   // mint Stripe sessions even with a token. Shares the standard fixed-window limiter.
   const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
   const brake = rateLimit(`subscribe:${ip}`, { limit: 20, windowMs: 60000 });
   if (!brake.allowed) {
      res.setHeader('Retry-After', Math.ceil(brake.retryAfterMs / 1000));
      return redirectToWelcome(res, baseUrl, 'error');
   }

   const token = typeof req.query.token === 'string' ? req.query.token : '';
   const accountId = verifySubscribeToken(token);
   if (accountId === null) {
      // Forged / expired / wrong-purpose token: mutate nothing, soft-land. A user can get a fresh link
      // from the next wall hit or trial-ending email.
      return redirectToWelcome(res, baseUrl, 'expired');
   }

   try {
      await ensureSynced();
      const account = await Account.findOne({ where: { ID: accountId } });
      if (!account) { return redirectToWelcome(res, baseUrl, 'error'); }

      // Already a paying ('active') subscriber: do not start a redundant checkout. Send them to the
      // welcome page (they can manage the plan from the billing portal). A trialing / expired /
      // canceled / past_due account is exactly who SHOULD subscribe, so those fall through to checkout.
      if (account.subscription_status === 'active') {
         return redirectToWelcome(res, baseUrl, 'active');
      }

      const result = await createCheckoutSession(account, 1, baseUrl);
      if (result.url) {
         return res.redirect(302, result.url);
      }
      // Billing not configured / Stripe error: soft-land rather than show a raw error.
      return redirectToWelcome(res, baseUrl, 'error');
   } catch (err) {
      console.log('[ERROR] /api/subscribe one-click checkout.');
      return redirectToWelcome(res, baseUrl, 'error');
   }
}
