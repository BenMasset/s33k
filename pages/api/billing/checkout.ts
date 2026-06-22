import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import authorize from '../../../utils/authorize';
import ensureAdminAccount from '../../../utils/ensureAdminAccount';
import { resolveBaseUrl } from '../../../utils/baseUrl';
import { getStripe, isStripeConfigured, priceIdPerSite } from '../../../utils/stripe';

// POST /api/billing/checkout { sites } -> { url }
// Creates a Stripe Checkout Session (mode 'subscription') for the caller's account and returns the
// hosted-checkout URL. The model is PER-UNIT: a single recurring price ($7 / site) bought with
// quantity = the requested number of sites (each site = 50 keywords). This is the ONLY place a card
// is collected: trials start with NO card, so a trialing account has no Stripe customer until it runs
// Checkout here. Owner/admin only (member / share keys are already 403'd before this by authorize()).
//
// Authed via authorize(); whitelisted in allowedApiRoutes. NOT a scoped-key route (billing is never
// reachable by a read-only share key). Dev-safe: with STRIPE_SECRET_KEY unset we return a clean
// "billing not configured" 503 instead of crashing.

type CheckoutRes = { url?: string, error?: string | null };

// Clamp the requested site quantity to a sane range. Default 1, min 1, max 100, integer only, so a
// missing / garbage / negative / absurd quantity can never create a runaway subscription.
const MIN_SITES = 1;
const MAX_SITES = 100;
const resolveSites = (raw: unknown): number => {
   const n = typeof raw === 'number' ? Math.floor(raw) : MIN_SITES;
   if (!Number.isFinite(n) || n < MIN_SITES) { return MIN_SITES; }
   if (n > MAX_SITES) { return MAX_SITES; }
   return n;
};

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
   if (!isStripeConfigured()) {
      return res.status(503).json({ error: 'Billing is not configured.' });
   }

   const sites = resolveSites((req.body && typeof req.body === 'object') ? req.body.sites : undefined);
   const priceId = priceIdPerSite();
   if (!priceId) {
      return res.status(503).json({ error: 'Billing price is not configured.' });
   }

   const stripe = getStripe();
   if (!stripe) {
      return res.status(503).json({ error: 'Billing is not configured.' });
   }

   try {
      // Reload the account as a persistable model row so we can store the Stripe customer id. The
      // resolved account is already a DB row for a tenant, but reloading by id keeps this robust.
      const row = await Account.findOne({ where: { ID: account.ID } });
      if (!row) {
         return res.status(400).json({ error: 'Account not found.' });
      }

      // Ensure a Stripe customer exists for this account; create + store it on first checkout.
      let customerId = row.stripe_customer_id;
      if (!customerId) {
         const customer = await stripe.customers.create({
            name: row.name || `s33k account ${row.ID}`,
            // Tie the Stripe customer back to the s33k account so the webhook can also reconcile by
            // metadata if a customer id ever drifts. The account id is not a secret.
            metadata: { s33k_account_id: String(row.ID) },
         });
         customerId = customer.id;
         row.stripe_customer_id = customerId;
         await row.save();
      }

      const baseUrl = resolveBaseUrl(req);

      // Model A: honor the remaining app-side trial in Stripe. If the account is still trialing
      // (trial_ends_at is a valid FUTURE timestamp), pass that same instant as the subscription's
      // trial_end so a user who subscribes mid-trial keeps their free days and is NOT charged
      // immediately. Stripe REJECTS a trial_end in the past, so we only set it when it is strictly in
      // the future; otherwise we omit it entirely and the subscription starts paid right away.
      const subscriptionData: Record<string, unknown> = { metadata: { s33k_account_id: String(row.ID) } };
      const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : NaN;
      if (Number.isFinite(trialEndsAt) && trialEndsAt > Date.now()) {
         subscriptionData.trial_end = Math.floor(trialEndsAt / 1000);
      }

      const session = await stripe.checkout.sessions.create({
         mode: 'subscription',
         customer: customerId,
         // ONE per-site price, QUANTITY = number of sites: this is the whole per-unit model. The
         // webhook reads this quantity back as account.paid_sites to set the caps.
         line_items: [{ price: priceId, quantity: sites }],
         success_url: `${baseUrl}/?billing=success`,
         cancel_url: `${baseUrl}/?billing=cancelled`,
         // Carry the account id on the session + subscription so the webhook can resolve the account
         // even before the customer id has propagated locally.
         client_reference_id: String(row.ID),
         subscription_data: subscriptionData,
      });

      if (!session.url) {
         return res.status(400).json({ error: 'Could not create a checkout session.' });
      }
      return res.status(200).json({ url: session.url });
   } catch (err) {
      // Never log the Stripe key or full error object verbatim; a short message is enough.
      console.log('[ERROR] Creating Stripe checkout session.');
      return res.status(400).json({ error: 'Could not start checkout.' });
   }
}
