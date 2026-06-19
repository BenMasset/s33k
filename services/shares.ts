import { useMutation, useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';

// Service hooks for per-domain read-only SHARING. The backend lives at /api/share:
//   GET    /api/share?domain=...   -> { shares: ShareSummary[] }  (owner-only)
//   POST   /api/share { domain, email } -> { invited, emailSent }  (mint-on-accept, no key in email)
//   DELETE /api/share?id=...       -> { revoked }
//
// A share grants the recipient a read-only, single-domain member key, minted only when they accept
// the emailed activation link. The owner never sees or handles the key in this flow.

export type ShareSummary = {
   ID: number,
   key_prefix: string,
   name: string | null,
   scoped_domain: string | null,
   created: string | null,
   last_used_at: string | null,
   revoked: boolean,
};

export type ShareListData = {
   shares?: ShareSummary[],
   error?: string | null,
};

export type ShareCreateData = {
   invited?: boolean,
   emailSent?: boolean,
   error?: string | null,
};

const fetchShares = async (domain: string): Promise<ShareListData> => {
   if (!domain) { return { shares: [] }; }
   const res = await fetch(`${window.location.origin}/api/share?domain=${encodeURIComponent(domain)}`, { method: 'GET' });
   if (res.status === 401 || res.status === 403) { return { shares: [] }; }
   return res.json();
};

export function useShares(domain: string) {
   return useQuery(['shares', domain], () => fetchShares(domain), {
      retry: false,
      staleTime: 30 * 1000,
      enabled: Boolean(domain),
   });
}

export function useShareDomain(domain: string, onSuccess?: (data: ShareCreateData) => void) {
   const queryClient = useQueryClient();
   return useMutation(async (email: string): Promise<ShareCreateData> => {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      const res = await fetch(`${window.location.origin}/api/share`, {
         method: 'POST',
         headers,
         body: JSON.stringify({ domain, email }),
      });
      const payload = await res.json();
      if (res.status >= 400 || !payload.invited) {
         throw new Error(payload?.error || 'Could not share this domain.');
      }
      return payload as ShareCreateData;
   }, {
      onSuccess: (data) => {
         queryClient.invalidateQueries(['shares', domain]);
         if (onSuccess) { onSuccess(data); }
      },
      onError: (error: Error) => {
         toast(error.message || 'Could not share this domain.', { icon: '⚠️' });
      },
   });
}

export function useRevokeShare(domain: string) {
   const queryClient = useQueryClient();
   return useMutation(async (id: number) => {
      const res = await fetch(`${window.location.origin}/api/share?id=${id}`, { method: 'DELETE' });
      const payload = await res.json();
      if (res.status >= 400 || !payload.revoked) {
         throw new Error(payload?.error || 'Could not revoke this share.');
      }
      return payload;
   }, {
      onSuccess: () => {
         toast('Share revoked.', { icon: '✔️' });
         queryClient.invalidateQueries(['shares', domain]);
      },
      onError: (error: Error) => {
         toast(error.message || 'Could not revoke this share.', { icon: '⚠️' });
      },
   });
}
