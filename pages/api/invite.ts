import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import Account from '../../database/models/account';
import Invite from '../../database/models/invite';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { generateInviteCode } from '../../utils/resolveAccount';
import { resolveBaseUrl } from '../../utils/baseUrl';
import { sendInviteEmail } from '../../utils/send-invite';

// Invite-management routes for the invite-only, multi-tenant s33k.
//
//   POST /api/invite  (authed admin) - create an invite.
//     - type 'external': brings a NEW admin + account into s33k. LIMITED per inviter by the
//       inviter account's external_invite_quota, enforced by COUNTING this account's external
//       invites (not by mutating a counter, so there is no lost-update race). This is the
//       viral lever. Requires an email so we know who to send it to.
//     - type 'internal': adds a read-only MEMBER seat to the CALLER's OWN account. Unlimited.
//       target_account_id is the caller's account. email is optional.
//   GET /api/invite  (authed admin) - list the invites this account has sent.
//
// Only admins may send invites: a read-only member key is already rejected on any non-GET by
// authorize(), and the POST path additionally requires the resolved role to be admin. With
// MULTI_TENANT off the only caller is the seeded admin account, so the gates are no-ops and
// the quota is effectively the default. The accept side lives in pages/api/invite/accept.ts
// and is PUBLIC (the code is the credential).

// Fall back to the account default (5) when the column is unset (older rows / pre-migration).
const DEFAULT_EXTERNAL_QUOTA = 5;

type InviteSummary = {
   ID: number,
   code: string,
   type: string,
   email: string | null,
   status: string,
   target_account_id: number | null,
   created: string | null,
   accepted_at: string | null,
};

type InviteCreateRes = {
   code?: string,
   link?: string,
   type?: string,
   emailSent?: boolean,
   error?: string | null,
};

type InviteListRes = {
   invites?: InviteSummary[],
   error?: string | null,
};

const toSummary = (invite: Invite): InviteSummary => ({
   ID: invite.ID,
   code: invite.code,
   type: invite.type,
   email: invite.email ?? null,
   status: invite.status,
   target_account_id: invite.target_account_id ?? null,
   created: invite.get('createdAt') ? new Date(invite.get('createdAt') as Date).toJSON() : null,
   accepted_at: invite.accepted_at ? new Date(invite.accepted_at).toJSON() : null,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await ensureSynced();
   await ensureAdminAccount();
   const { authorized, account, role, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   // Only admins send or list invites. authorize() already blocks member keys on non-GET, but
   // we also block them on GET here: a read-only seat should not enumerate the account's invites.
   if (role === 'member') {
      return res.status(403).json({ error: 'Read-only member' });
   }
   if (req.method === 'POST') {
      return createInvite(req, res, account);
   }
   if (req.method === 'GET') {
      return listInvites(res, account);
   }
   return res.status(405).json({ error: 'Method Not Allowed. Use POST or GET.' });
}

const createInvite = async (req: NextApiRequest, res: NextApiResponse<InviteCreateRes>, account: Account) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const type = typeof body.type === 'string' ? body.type.trim() : '';
   const email = typeof body.email === 'string' ? body.email.trim() : '';

   if (type !== 'external' && type !== 'internal') {
      return res.status(400).json({ error: "type must be 'external' or 'internal'." });
   }
   if (type === 'external' && !email) {
      return res.status(400).json({ error: 'email is required for an external invite.' });
   }

   try {
      if (type === 'external') {
         // Enforce the quota by counting outstanding+accepted external invites this account
         // has created. Counting (not decrementing a counter) avoids a lost-update race when
         // two invites are created concurrently. Revoked/expired invites do not count.
         const quota = typeof account.external_invite_quota === 'number'
            ? account.external_invite_quota
            : DEFAULT_EXTERNAL_QUOTA;
         const used = await Invite.count({
            where: {
               inviter_account_id: account.ID,
               type: 'external',
               status: { [Op.in]: ['pending', 'accepted'] },
            },
         });
         if (used >= quota) {
            return res.status(403).json({ error: 'External invite quota exhausted.' });
         }
      }

      const code = generateInviteCode();
      const invite = await Invite.create({
         code,
         inviter_account_id: account.ID,
         type,
         email: email || null,
         // Internal invites join the caller's own account; external invites have no account yet.
         target_account_id: type === 'internal' ? account.ID : null,
         status: 'pending',
      });

      const link = `${resolveBaseUrl(req)}/invite/${invite.code}`;
      // Best-effort email; if Resend is unconfigured or fails, the link is the fallback and we
      // never fail the invite for it.
      let emailSent = false;
      if (email) {
         const result = await sendInviteEmail({
            to: email,
            acceptLink: link,
            type,
            inviterName: account.name,
         });
         emailSent = result.sent;
      }

      return res.status(201).json({ code: invite.code, link, type, emailSent });
   } catch (error) {
      console.log('[ERROR] Creating Invite: ', error);
      return res.status(400).json({ error: 'Error Creating Invite.' });
   }
};

const listInvites = async (res: NextApiResponse<InviteListRes>, account: Account) => {
   try {
      const invites = await Invite.findAll({
         where: { inviter_account_id: account.ID },
         order: [['ID', 'DESC']],
      });
      return res.status(200).json({ invites: invites.map(toSummary) });
   } catch (error) {
      console.log('[ERROR] Listing Invites: ', error);
      return res.status(400).json({ error: 'Error Listing Invites.' });
   }
};
