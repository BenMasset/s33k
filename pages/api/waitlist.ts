import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Waitlist from '../../database/models/waitlist';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { isAdminAccount } from '../../utils/scope';

// Waitlist routes.
//
//   POST /api/waitlist  (PUBLIC, no API key) - anyone without an invite signs up here. Runs
//     pre-account, so it takes no auth and validates its own input (basic email shape, dedupe
//     by email). It never reveals whether an email already exists: a duplicate returns the same
//     success shape as a fresh signup, so the endpoint cannot be used to probe for known emails.
//   GET /api/waitlist  (ADMIN only, account.ID === ADMIN_ACCOUNT_ID) - the seeded admin reads
//     the list to decide who to send external invites to. The GET is gated; the POST is open.
//
// The POST is intentionally NOT in the API-route whitelist: like the invite-accept route, it
// runs before any account exists and is reached without a Bearer key. The GET is authed and is
// whitelisted in utils/allowedApiRoutes.ts.

// A deliberately permissive email sanity check. We are not validating deliverability, only
// rejecting obviously-not-an-email input. Real verification happens when an invite is sent.
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

type WaitlistSummary = {
   ID: number,
   email: string,
   domain: string | null,
   note: string | null,
   status: string,
   created: string | null,
};

type WaitlistCreateRes = {
   success?: boolean,
   message?: string,
   error?: string | null,
};

type WaitlistListRes = {
   waitlist?: WaitlistSummary[],
   error?: string | null,
};

const toSummary = (row: Waitlist): WaitlistSummary => ({
   ID: row.ID,
   email: row.email,
   domain: row.domain ?? null,
   note: row.note ?? null,
   status: row.status,
   created: row.get('createdAt') ? new Date(row.get('createdAt') as Date).toJSON() : null,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   await ensureAdminAccount();

   if (req.method === 'POST') {
      // PUBLIC: no auth. Validate and write directly.
      return joinWaitlist(req, res);
   }
   if (req.method === 'GET') {
      // ADMIN-only read.
      await ensureAdminAccount();
      const { authorized, account, error } = await authorize(req, res);
      if (!authorized || !account) {
         return res.status(401).json({ error: error || 'Not authorized' });
      }
      // isAdminAccount is the admin sentinel id but never a scoped share-key account, so a share
      // key minted on the admin account cannot read the waitlist (belt: the share-key allowlist
      // already denies this GET route).
      if (!isAdminAccount(account)) {
         return res.status(403).json({ error: 'Admin access required.' });
      }
      return listWaitlist(res);
   }
   return res.status(405).json({ error: 'Method Not Allowed. Use POST or GET.' });
}

const joinWaitlist = async (req: NextApiRequest, res: NextApiResponse<WaitlistCreateRes>) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   const note = typeof body.note === 'string' ? body.note.trim() : '';

   if (!email || !looksLikeEmail(email)) {
      return res.status(400).json({ error: 'A valid email is required.' });
   }

   const thankYou = { success: true, message: 'Thanks. You are on the waitlist and we will be in touch.' };
   try {
      // Dedupe by email. A repeat signup returns the SAME success response as a new one, so the
      // endpoint never reveals whether an email is already on the list.
      const existing = await Waitlist.findOne({ where: { email } });
      if (existing) {
         return res.status(200).json(thankYou);
      }
      await Waitlist.create({
         email,
         domain: domain || null,
         note: note || null,
         status: 'waiting',
      });
      return res.status(201).json(thankYou);
   } catch (error) {
      // A unique-constraint collision (concurrent duplicate) is not an error from the user's
      // point of view: they are on the list. Return the same thank-you rather than a 4xx.
      const name = (error as { name?: string })?.name || '';
      if (name === 'SequelizeUniqueConstraintError') {
         return res.status(200).json(thankYou);
      }
      console.log('[ERROR] Joining Waitlist: ', error);
      return res.status(400).json({ error: 'Error joining the waitlist.' });
   }
};

const listWaitlist = async (res: NextApiResponse<WaitlistListRes>) => {
   try {
      const rows = await Waitlist.findAll({ order: [['ID', 'DESC']] });
      return res.status(200).json({ waitlist: rows.map(toSummary) });
   } catch (error) {
      console.log('[ERROR] Listing Waitlist: ', error);
      return res.status(400).json({ error: 'Error Listing Waitlist.' });
   }
};
