import { useMutation, useQuery } from 'react-query';
import toast from 'react-hot-toast';

type BillingCaps = {
   sites: number,
   keywords: number,
   cadenceDays: number,
};

export type BillingStatus = {
   // `plan` is retained as an OPTIONAL legacy field: the per-unit model has no named tiers, but the
   // status route still returns plan: 'admin' for the single-tenant sentinel and the TopBar notice
   // keys off that. A real tenant simply has no plan; gating reads subscription_status + caps.
   plan?: string | null,
   subscription_status?: string | null,
   trial_ends_at?: string | null,
   paid_sites?: number | null,
   isActive?: boolean,
   caps?: BillingCaps,
   error?: string | null,
};

const fetchBillingStatus = async (): Promise<BillingStatus> => {
   const res = await fetch(`${window.location.origin}/api/billing/status`, { method: 'GET' });
   if (res.status === 401) { return { isActive: true, plan: 'unknown' }; }
   return res.json();
};

export function useBillingStatus() {
   return useQuery('billing-status', fetchBillingStatus, {
      staleTime: 60 * 1000,
      retry: false,
   });
}

// useStartCheckout starts a Stripe Checkout for a quantity of SITES ($7 each, 50 keywords each).
// The mutation argument is the number of sites (default 1). A legacy string argument (the old tier
// name) is tolerated and coerced to the default 1 site, so existing callers keep working.
export function useStartCheckout() {
   return useMutation(async (sites: number | string | void = 1) => {
      const siteCount = typeof sites === 'number' && sites > 0 ? Math.floor(sites) : 1;
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      const res = await fetch(`${window.location.origin}/api/billing/checkout`, {
         method: 'POST',
         headers,
         body: JSON.stringify({ sites: siteCount }),
      });
      const payload = await res.json();
      if (res.status >= 400 || !payload.url) {
         throw new Error(payload?.error || 'Could not start checkout.');
      }
      return payload.url as string;
   }, {
      onSuccess: (url) => { window.location.href = url; },
      onError: (error: Error) => {
         toast(error.message || 'Could not start checkout.', { icon: '⚠️' });
      },
   });
}
