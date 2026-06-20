import type { NextApiRequest, NextApiResponse } from 'next';
import { ensureSynced } from '../../database/database';
import Waitlist from '../../database/models/waitlist';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { isAdminAccount } from '../../utils/scope';
import { rateLimit } from '../../utils/rate-limit';
import { clientIp } from '../../utils/collect-guards';
import { notifyWaitlist } from '../../utils/notify-waitlist';

// Hard length caps on the PUBLIC waitlist write (audit area 1). This is the least-defended
// unauthenticated write surface, so cap every field before persisting: an email max is 254 (RFC
// 5321), a domain max mirrors collect's MAX_DOMAIN_LEN, and the free-text note maps to a TEXT
// column with no DB bound, so cap it tight so a stranger cannot write megabyte blobs row after row.
const MAX_EMAIL_LEN = 254;
const MAX_DOMAIN_LEN = 255;
const MAX_NOTE_LEN = 500;

// Per-IP request brake on the open POST, same shape collect.ts uses. Bounds how fast one source
// can flood the waitlist table with junk rows. Generous for a human signing up; a hard brake on
// a flood. Overridable via env. The IP is derived from the trusted-edge XFF hop (collect-guards).
const WAITLIST_RATE_LIMIT = (() => {
   const raw = parseInt(process.env.WAITLIST_RATE_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 20;
})();
const WAITLIST_RATE_WINDOW_MS = (() => {
   const raw = parseInt(process.env.WAITLIST_RATE_WINDOW_MS || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
})();

// Dedicated GLOBAL brake on the notify FAN-OUT (owner email + Resend contact create), separate
// from the per-IP write brake above. The per-IP limit bounds rows-per-IP, but across rotating IPs
// the open endpoint could still amplify into Ben's inbox and the Resend segment. This cap is global
// (one bucket, not keyed by IP) so the outbound side effect is hard-capped regardless of how many
// sources hit it. The waitlist ROW still persists for every honest signup; only the email/contact
// amplification is throttled. Generous for real signup volume, a hard ceiling against an inbox bomb.
const WAITLIST_NOTIFY_LIMIT = (() => {
   const raw = parseInt(process.env.WAITLIST_NOTIFY_LIMIT || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 50;
})();
const WAITLIST_NOTIFY_WINDOW_MS = (() => {
   const raw = parseInt(process.env.WAITLIST_NOTIFY_WINDOW_MS || '', 10);
   return Number.isFinite(raw) && raw > 0 ? raw : 60 * 1000;
})();

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
   await ensureSynced();
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
   // Per-IP request brake FIRST, before any parsing/DB work, so a flood is cheapest to reject.
   const ip = clientIp(req.headers as Record<string, string | string[] | undefined>, req.socket?.remoteAddress);
   const rl = rateLimit(`waitlist:${ip}`, { limit: WAITLIST_RATE_LIMIT, windowMs: WAITLIST_RATE_WINDOW_MS });
   if (!rl.allowed) {
      res.setHeader('Retry-After', Math.ceil(rl.retryAfterMs / 1000));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
   }

   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   // Trim THEN hard-cap every stored field. The note maps to an unbounded TEXT column, so the cap
   // is the only thing standing between an open endpoint and arbitrarily large blobs.
   const email = typeof body.email === 'string' ? body.email.trim().toLowerCase().slice(0, MAX_EMAIL_LEN) : '';
   const domain = typeof body.domain === 'string' ? body.domain.trim().slice(0, MAX_DOMAIN_LEN) : '';
   const note = typeof body.note === 'string' ? body.note.trim().slice(0, MAX_NOTE_LEN) : '';

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
      // Best-effort side effects on a NEW signup only (the dedupe path above returns before here,
      // so a repeat submit never re-emails or re-adds). notifyWaitlist never throws; we do not
      // await it into the response so a slow Resend call cannot delay the user's confirmation.
      // Gated behind a GLOBAL notify brake so the open endpoint cannot be used as an inbox/contact
      // bomb across rotating IPs; the row above is already persisted either way.
      const notifyBrake = rateLimit('waitlist-notify-global', {
         limit: WAITLIST_NOTIFY_LIMIT, windowMs: WAITLIST_NOTIFY_WINDOW_MS,
      });
      if (notifyBrake.allowed) {
         notifyWaitlist({ email, domain: domain || null, note: note || null }).catch(() => undefined);
      }
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
