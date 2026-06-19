import type { NextApiRequest, NextApiResponse } from 'next';
import type Stripe from 'stripe';
import { ensureSynced } from '../../../database/database';
import Account from '../../../database/models/account';
import { getStripe, isStripeConfigured } from '../../../utils/stripe';

// POST /api/billing/webhook -> PUBLIC, signature-verified Stripe webhook.
//
// SECURITY / GOTCHA: Stripe signature verification requires the EXACT RAW request body bytes. Next's
// default JSON bodyParser would mutate them and break the signature, so we DISABLE it here
// (`config.api.bodyParser = false`) and read the raw stream ourselves. The signature is then
// verified with stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET). A bad/absent
// signature returns 400 and mutates NOTHING.
//
// This route is intentionally NOT in allowedApiRoutes.ts: it takes no API key. It is PUBLIC and
// secured by the signed Stripe signature instead, the same pattern as the GSC OAuth callback (a
// public route secured by a verifiable signature, not the key whitelist). Do not whitelist it.
//
// Handling is IDEMPOTENT (Stripe retries deliver the same event repeatedly): every handler does a
// set-to-target update keyed by stripe_customer_id (or the s33k_account_id metadata fallback), so
// replaying an event lands the account in the same state. We never log the signing secret or key.

export const config = { api: { bodyParser: false } };

type WebhookRes = { received?: boolean, error?: string | null };

// Read the raw request body bytes off the stream. With bodyParser disabled the body is NOT parsed,
// so the Buffer we assemble here is exactly what Stripe signed.
const readRawBody = (req: NextApiRequest): Promise<Buffer> => new Promise((resolve, reject) => {
   const chunks: Buffer[] = [];
   req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
   req.on('end', () => resolve(Buffer.concat(chunks)));
   req.on('error', (err) => reject(err));
});

// Resolve the s33k account for a Stripe object: prefer the s33k_account_id we stamped in metadata at
// checkout, fall back to looking the account up by its stored stripe_customer_id. Returns null when
// neither resolves (e.g. an event for a customer we do not know), so a stray event is a clean no-op.
const resolveAccount = async (
   customerId: string | null | undefined,
   accountIdMeta: string | null | undefined,
): Promise<Account | null> => {
   if (accountIdMeta) {
      const id = parseInt(accountIdMeta, 10);
      if (Number.isFinite(id)) {
         const byMeta = await Account.findOne({ where: { ID: id } });
         if (byMeta) { return byMeta; }
      }
   }
   if (customerId) {
      return Account.findOne({ where: { stripe_customer_id: customerId } });
   }
   return null;
};

// Pull the QUANTITY off a subscription's first line item: the number of sites purchased in the
// per-unit model. Stored as account.paid_sites. Null when absent/invalid (leave the prior value).
const quantityOfSubscription = (sub: Stripe.Subscription): number | null => {
   const item = sub.items && sub.items.data && sub.items.data[0];
   const qty = item && (item as unknown as { quantity?: number }).quantity;
   return typeof qty === 'number' && Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : null;
};

// Apply a subscription's state to the account: stamp customer id, paid_sites (the subscription
// QUANTITY = number of sites), subscription_status, and current_period_end. Builds a partial update
// and writes it via account.update (the codebase mutate-via-update convention, refresh.ts), so it is
// idempotent (a replay sets the same values) and does not reassign the parameter's properties. There
// is no plan in the per-unit model, so nothing maps a price to a tier here.
const applySubscription = async (account: Account, sub: Stripe.Subscription, customerId: string | null): Promise<void> => {
   const updates: Record<string, unknown> = {};
   if (customerId && !account.stripe_customer_id) { updates.stripe_customer_id = customerId; }
   const quantity = quantityOfSubscription(sub);
   if (quantity !== null) { updates.paid_sites = quantity; }
   if (typeof sub.status === 'string') { updates.subscription_status = sub.status; }
   // current_period_end is unix seconds on the Stripe object; store it as a real Date.
   const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
   if (typeof periodEnd === 'number' && Number.isFinite(periodEnd)) {
      updates.current_period_end = new Date(periodEnd * 1000);
   }
   await account.update(updates);
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<WebhookRes>) {
   if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method Not Allowed. Use POST.' });
   }
   const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
   const stripe = getStripe();
   if (!isStripeConfigured() || !stripe || !webhookSecret) {
      return res.status(503).json({ error: 'Billing is not configured.' });
   }

   const signature = req.headers['stripe-signature'];
   if (!signature || typeof signature !== 'string') {
      // No signature: reject before doing any work. Never mutate on an unsigned request.
      return res.status(400).json({ error: 'Missing signature.' });
   }

   let event: Stripe.Event;
   try {
      const rawBody = await readRawBody(req);
      // Verifies the HMAC signature against the raw bytes. THROWS on a bad/forged/expired signature.
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
   } catch (err) {
      // Bad signature (or unreadable body): 400 and mutate NOTHING. Do not log the raw error verbatim.
      return res.status(400).json({ error: 'Invalid signature.' });
   }

   await ensureSynced();

   try {
      switch (event.type) {
         case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            const customerId = typeof session.customer === 'string' ? session.customer : null;
            const accountIdMeta = (session.client_reference_id || (session.metadata && session.metadata.s33k_account_id)) || null;
            const account = await resolveAccount(customerId, accountIdMeta);
            if (account) {
               // The subscription may be an id (string) or expanded object; fetch it to read the plan.
               const subId = typeof session.subscription === 'string' ? session.subscription : null;
               if (subId) {
                  const sub = await stripe.subscriptions.retrieve(subId);
                  await applySubscription(account, sub, customerId);
               } else {
                  // No subscription on the session yet: at minimum record the customer id + active.
                  const updates: Record<string, unknown> = { subscription_status: 'active' };
                  if (customerId && !account.stripe_customer_id) { updates.stripe_customer_id = customerId; }
                  await account.update(updates);
               }
            }
            break;
         }
         case 'customer.subscription.created':
         case 'customer.subscription.updated': {
            const sub = event.data.object as Stripe.Subscription;
            const customerId = typeof sub.customer === 'string' ? sub.customer : null;
            const accountIdMeta = (sub.metadata && sub.metadata.s33k_account_id) || null;
            const account = await resolveAccount(customerId, accountIdMeta);
            if (account) { await applySubscription(account, sub, customerId); }
            break;
         }
         case 'customer.subscription.deleted': {
            const sub = event.data.object as Stripe.Subscription;
            const customerId = typeof sub.customer === 'string' ? sub.customer : null;
            const accountIdMeta = (sub.metadata && sub.metadata.s33k_account_id) || null;
            const account = await resolveAccount(customerId, accountIdMeta);
            if (account) { await account.update({ subscription_status: 'canceled' }); }
            break;
         }
         case 'invoice.payment_failed': {
            const invoice = event.data.object as Stripe.Invoice;
            const customerId = typeof invoice.customer === 'string' ? invoice.customer : null;
            const account = await resolveAccount(customerId, null);
            if (account) { await account.update({ subscription_status: 'past_due' }); }
            break;
         }
         default:
            // Unhandled event types are acknowledged so Stripe stops retrying.
            break;
      }
      return res.status(200).json({ received: true });
   } catch (err) {
      // A processing error is logged tersely and returned as 400 so Stripe RETRIES later (the
      // handlers are idempotent, so a retry is safe). Never log the raw event or any secret.
      console.log('[ERROR] Processing Stripe webhook event:', event.type);
      return res.status(400).json({ error: 'Webhook processing error.' });
   }
}
