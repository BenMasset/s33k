import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import authorize from '../../../utils/authorize';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { resolveBaseUrl } from '../../../utils/baseUrl';
import { getStripe, isStripeConfigured } from '../../../utils/stripe';

// POST /api/billing/portal -> { url }
// Creates a Stripe Billing Portal session for the caller's account (manage / cancel / update card)
// and returns the portal URL. Authed via authorize(); whitelisted in allowedApiRoutes; NOT a
// scoped-key route. Dev-safe: returns a clean error when Stripe is unconfigured or the account has
// no Stripe customer yet (it has never checked out).

type PortalRes = { url?: string, error?: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<PortalRes>) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured.' });
   }

   const stripe = getStripe();
   if (!stripe) {
      return res.status(503).json({ error: 'Billing is not configured.' });
   }

   try {
      const row = await Account.findOne({ where: { ID: account.ID } });
      if (!row || !row.stripe_customer_id) {
         return res.status(400).json({ error: 'No billing account yet. Subscribe first.' });
      }
      const baseUrl = resolveBaseUrl(req);
      // Return to the dashboard (not /welcome): the portal is for an EXISTING subscriber managing
      // their card/plan, so the right landing after they finish is their live dashboard, not the
      // post-checkout confirmation pointer. /welcome is the first-time pay-loop landing only.
      const session = await stripe.billingPortal.sessions.create({
         customer: row.stripe_customer_id,
         return_url: `${baseUrl}/`,
      });
      return res.status(200).json({ url: session.url });
   } catch (err) {
      console.log('[ERROR] Creating Stripe billing portal session.');
      return res.status(400).json({ error: 'Could not open the billing portal.' });
   }
}
