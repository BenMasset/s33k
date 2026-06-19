import { useQuery } from 'react-query';

// Service hook for the ADMIN-only waitlist view. GET /api/waitlist returns the public-signup queue:
//   { waitlist: [{ ID, email, domain, note, status, created }] }
// The route is admin-gated server-side (401 for unauthenticated, 403 for a non-admin account), so a
// non-admin caller resolves to an empty list here and the admin-only UI never renders for them.

export type WaitlistEntry = {
   ID: number,
   email: string,
   domain: string | null,
   note: string | null,
   status: string,
   created: string | null,
};

export type WaitlistData = {
   waitlist?: WaitlistEntry[],
   error?: string | null,
};

const fetchWaitlist = async (): Promise<WaitlistData> => {
   const res = await fetch(`${window.location.origin}/api/waitlist`, { method: 'GET' });
   if (res.status === 401 || res.status === 403) { return { waitlist: [] }; }
   return res.json();
};

// `enabled` lets the caller skip the request entirely for non-admins (the UI already gates on the
// admin signal), so a member never even fires the request that the server would 403 anyway.
export function useWaitlist(enabled = true) {
   return useQuery('waitlist', fetchWaitlist, { retry: false, staleTime: 30 * 1000, enabled });
}
