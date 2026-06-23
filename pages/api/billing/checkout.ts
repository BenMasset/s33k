import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import authorize from '../../../utils/authorize';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { resolveBaseUrl } from '../../../utils/baseUrl';
import { createCheckoutSession, resolveSites } from '../../../utils/billing-checkout';

// POST /api/billing/checkout { sites } -> { url }
// Returns the hosted Stripe Checkout URL for the caller's account (start_checkout in the LLM). The
// per-unit model, the mid-trial trial_end coordination, and the /welcome redirect all live in the
// shared utils/billing-checkout.ts createCheckoutSession, so this route and the token-authed
// /api/subscribe one-click link can never drift. Owner/admin only (member / share keys are already
// 403'd before this by authorize()). Whitelisted in allowedApiRoutes; NOT a scoped-key route.
// Dev-safe: createCheckoutSession returns a clean 503 when Stripe is unconfigured.

type CheckoutRes = { url?: string, error?: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<CheckoutRes>) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }

   const sites = resolveSites((req.body && typeof req.body === 'object') ? req.body.sites : undefined);
   const baseUrl = resolveBaseUrl(req);
   const result = await createCheckoutSession(account, sites, baseUrl);
   if (result.url) {
      return res.status(200).json({ url: result.url });
   }
   return res.status(result.status || 400).json({ error: result.error || 'Could not start checkout.' });
}
