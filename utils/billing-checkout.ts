import Stripe from 'stripe';
import Account from '../database/models/account';
import { getStripe, isStripeConfigured, priceIdPerSite } from './stripe';

// Shared Stripe-checkout-session creation, used by BOTH the key-authed POST /api/billing/checkout
// (start_checkout in the LLM) AND the token-authed GET /api/subscribe one-click pay link (from the
// trial-ended wall, the banners, and the dunning email). Keeping one implementation means the
// per-unit model, the mid-trial trial_end coordination, and the /welcome redirect can never drift
// between the two entry points.

// Clamp the requested site quantity: default 1, min 1, max 100, integer only, so a missing / garbage /
// negative / absurd quantity can never create a runaway subscription. (Moved here verbatim from the
// checkout route so both entry points clamp identically.)
const MIN_SITES = 1;
const MAX_SITES = 100;
export const resolveSites = (raw: unknown): number => {
   const n = typeof raw === 'number' ? Math.floor(raw) : MIN_SITES;
   if (!Number.isFinite(n) || n < MIN_SITES) { return MIN_SITES; }
   if (n > MAX_SITES) { return MAX_SITES; }
   return n;
};

export type CheckoutResult = { url?: string, error?: string, status?: number };

/**
 * Create a Stripe Checkout Session (mode 'subscription') for an account and return its hosted URL.
 * PER-UNIT model: one recurring $7/site price bought with quantity = sites. This is the ONLY place a
 * card is collected (trials never collect one), so a trialing account has no Stripe customer until it
 * runs checkout here. Honors the remaining app-side trial via subscription_data.trial_end so a user
 * who subscribes mid-trial keeps their free days and is not charged until the trial ends.
 *
 * Never throws: returns { error, status } on any failure so both callers can map it to a clean
 * response (a 503/400 JSON for the API route, a friendly redirect for the link route).
 * @param {Account} account - the resolved account (its id is reloaded to a persistable row here).
 * @param {number} sites - requested site quantity (clamped via resolveSites by the caller or here).
 * @param {string} baseUrl - the trusted public base URL (from resolveBaseUrl) for success/cancel URLs.
 * @returns {Promise<CheckoutResult>} { url } on success, else { error, status }.
 */
export const createCheckoutSession = async (account: Account, sites: number, baseUrl: string): Promise<CheckoutResult> => {
   if (!isStripeConfigured()) { return { error: 'Billing is not configured.', status: 503 }; }
   const priceId = priceIdPerSite();
   if (!priceId) { return { error: 'Billing price is not configured.', status: 503 }; }
   const stripe = getStripe();
   if (!stripe) { return { error: 'Billing is not configured.', status: 503 }; }

   try {
      // Reload as a persistable row so we can store the Stripe customer id on first checkout.
      const row = await Account.findOne({ where: { ID: account.ID } });
      if (!row) { return { error: 'Account not found.', status: 400 }; }

      // Ensure a Stripe customer exists for this account; create + store it on first checkout. The
      // account id is stamped in metadata so the webhook can reconcile by metadata if a customer id
      // ever drifts. The account id is not a secret.
      let customerId = row.stripe_customer_id;
      if (!customerId) {
         const customer = await stripe.customers.create({
            name: row.name || `s33k account ${row.ID}`,
            metadata: { s33k_account_id: String(row.ID) },
         });
         customerId = customer.id;
         row.stripe_customer_id = customerId;
         await row.save();
      }

      // Model A: honor the remaining app-side trial in Stripe. Only set trial_end when trial_ends_at is
      // a valid FUTURE timestamp (Stripe rejects a past trial_end); otherwise omit it and the
      // subscription starts paid immediately (the normal day-14 wall -> pay case).
      const subscriptionData: Record<string, unknown> = { metadata: { s33k_account_id: String(row.ID) } };
      const trialEndsAt = row.trial_ends_at ? new Date(row.trial_ends_at).getTime() : NaN;
      if (Number.isFinite(trialEndsAt) && trialEndsAt > Date.now()) {
         subscriptionData.trial_end = Math.floor(trialEndsAt / 1000);
      }

      const session = await stripe.checkout.sessions.create({
         mode: 'subscription',
         customer: customerId,
         line_items: [{ price: priceId, quantity: sites }],
         success_url: `${baseUrl}/welcome?billing=success`,
         cancel_url: `${baseUrl}/welcome?billing=cancelled`,
         client_reference_id: String(row.ID),
         subscription_data: subscriptionData,
      });

      if (!session.url) { return { error: 'Could not create a checkout session.', status: 400 }; }
      return { url: session.url };
   } catch (err) {
      // Never log the Stripe key or full error object verbatim; a short message is enough.
      console.log('[ERROR] Creating Stripe checkout session.');
      return { error: 'Could not start checkout.', status: 400 };
   }
};

export default createCheckoutSession;
