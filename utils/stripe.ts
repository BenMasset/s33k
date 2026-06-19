import Stripe from 'stripe';

// The Stripe layer for s33k billing. Everything here is LAZY and DEV-SAFE: when STRIPE_SECRET_KEY
// is unset (local dev, self-host without billing, every jest run) getStripe() returns null and the
// billing routes report "billing not configured" instead of crashing. No secret is ever logged.
//
// Only meaningful with MULTI_TENANT on (billing applies to tenants, never the single admin).
//
// The model is PER-UNIT: ONE recurring Stripe price ($7 per site), and the subscription QUANTITY is
// the number of sites. There are no named tiers, so there is a single price env and no price->plan
// reverse map: the webhook reads the subscription QUANTITY, not which price was bought.

// Lazily constructed singleton. We build it on first use, not at module load, so importing this
// file (e.g. into a route or a test) never requires the key to be present.
let client: Stripe | null = null;

// getStripe returns the configured Stripe client, or null when STRIPE_SECRET_KEY is unset. Callers
// MUST handle null (return a clean "billing not configured" error). Never throws on a missing key.
export const getStripe = (): Stripe | null => {
   const key = process.env.STRIPE_SECRET_KEY;
   if (!key || !key.trim()) { return null; }
   if (!client) {
      // No apiVersion pin: let the SDK use its bundled default, so a key from any Stripe account
      // works without a version mismatch. The SDK reads ONLY this secret; nothing is logged.
      client = new Stripe(key.trim());
   }
   return client;
};

// isStripeConfigured is the cheap predicate routes use to short-circuit to a friendly error.
export const isStripeConfigured = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY.trim());

// The env var that holds the single per-site recurring Stripe Price id. The operator creates ONE
// recurring Price in Stripe ($7 / site / month) and sets this. Checkout buys it with quantity = sites.
const PRICE_PER_SITE_ENV = 'STRIPE_PRICE_PER_SITE';

// priceIdPerSite returns the configured per-site Stripe Price id, or null when its env is unset. The
// checkout route treats null as "billing price not configured" and returns a clean error.
export const priceIdPerSite = (): string | null => {
   const raw = process.env[PRICE_PER_SITE_ENV];
   return raw && raw.trim() ? raw.trim() : null;
};
