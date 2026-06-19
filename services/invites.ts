import { useMutation, useQuery, useQueryClient } from 'react-query';
import toast from 'react-hot-toast';

// Service hooks for the in-app invite loop. The backend lives at /api/invite:
//   GET  /api/invite  -> { invites: InviteSummary[] }  (this account's sent invites)
//   POST /api/invite  { type, email } -> { code, link, type, emailSent } | { error }
//
// An EXTERNAL invite lets the recipient create their OWN s33k account (a 14-day trial). External
// invites are quota-limited per account (default 5), enforced server-side by counting pending +
// accepted external invites. We mirror that count on the client to show "X of N invites left".

// The account default external-invite quota. The server falls back to this same value when the
// account column is unset, so the UI shows the right "left" count even before we know the real
// quota number (which the list endpoint does not return today).
export const DEFAULT_EXTERNAL_QUOTA = 5;

export type InviteSummary = {
   ID: number,
   code: string,
   type: string,
   email: string | null,
   status: string,
   target_account_id: number | null,
   created: string | null,
   accepted_at: string | null,
};

export type InviteListData = {
   invites?: InviteSummary[],
   error?: string | null,
};

export type InviteCreateData = {
   code?: string,
   link?: string,
   type?: string,
   emailSent?: boolean,
   error?: string | null,
};

const fetchInvites = async (): Promise<InviteListData> => {
   const res = await fetch(`${window.location.origin}/api/invite`, { method: 'GET' });
   // A non-admin / read-only member gets 403 here. Treat it as "no invites to show" rather than an
   // error toast: the panel simply will not render the list for those callers.
   if (res.status === 401 || res.status === 403) { return { invites: [] }; }
   return res.json();
};

export function useInvites() {
   return useQuery('invites', fetchInvites, { retry: false, staleTime: 30 * 1000 });
}

// usedExternalInvites counts the external invites that consume quota: status pending or accepted.
// Revoked / expired invites do not count, matching the server-side quota enforcement.
export const usedExternalInvites = (invites?: InviteSummary[]): number => {
   if (!invites || invites.length === 0) { return 0; }
   return invites.filter((invite) => (
      invite.type === 'external' && (invite.status === 'pending' || invite.status === 'accepted')
   )).length;
};

export function useSendInvite(onSuccess?: (data: InviteCreateData) => void) {
   const queryClient = useQueryClient();
   return useMutation(async (email: string): Promise<InviteCreateData> => {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json' });
      const res = await fetch(`${window.location.origin}/api/invite`, {
         method: 'POST',
         headers,
         body: JSON.stringify({ type: 'external', email }),
      });
      const payload = await res.json();
      if (res.status >= 400 || !payload.code) {
         // Surface the server message verbatim so the quota-exhausted copy ("External invite quota
         // exhausted.") reaches the UI, which maps it to the friendly "used all your invites" line.
         throw new Error(payload?.error || 'Could not send invite.');
      }
      return payload as InviteCreateData;
   }, {
      onSuccess: (data) => {
         queryClient.invalidateQueries('invites');
         if (onSuccess) { onSuccess(data); }
      },
      onError: (error: Error) => {
         toast(error.message || 'Could not send invite.', { icon: '⚠️' });
      },
   });
}
