import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import Account from '../../database/models/account';
import FeatureRequest from '../../database/models/featureRequest';
import authorize from '../../utils/authorize';
import ensureAdminAccount from '../../utils/ensureAdminAccount';
import { isAdminAccount, ownerIdFor } from '../../utils/scope';
import { crossCheckCapability } from '../../utils/knowledge';
import { notifyFeatureRequest } from '../../utils/notify-feature-request';

// Feature-request routes, the storage + admin side of the request_feature MCP flow.
//
//   POST /api/feature-request  (authed) - a user's LLM submits a request for a capability s33k
//     does NOT have. Before storing, the SERVER-SIDE SAFETY NET runs crossCheckCapability (the
//     single source for "does it exist?", shared with the help tool and the coverage test). If
//     the request strongly matches a capability s33k already ships, the route returns
//     { matched: true, capability, message } and stores NOTHING, so a duplicate of an existing
//     feature never lands in the table even if the LLM skipped its own confirm step. Otherwise
//     the request is stored and the team is (optionally, gracefully) emailed via Resend.
//     A read-only member key is already 403'd on any non-GET by authorize(), so only admins
//     submit; that is acceptable because filing a request is a write.
//   GET /api/feature-request  (ADMIN only, account.ID === ADMIN_ACCOUNT_ID) - the seeded admin
//     reviews submitted requests, optionally filtered by status. Mirrors the waitlist GET gate.
//
// Both methods are authed and whitelisted in utils/allowedApiRoutes.ts.

const STATUSES = ['open', 'reviewed', 'planned', 'declined', 'shipped'];

type FeatureRequestSummary = {
   ID: number,
   account_id: number,
   request: string,
   context: string | null,
   status: string,
   matched_capability: string | null,
   created: string | null,
};

type CreateRes = {
   stored?: boolean,
   request_id?: number,
   matched?: boolean,
   capability?: { toolName: string, title: string } | null,
   message?: string,
   emailSent?: boolean,
   error?: string | null,
};

type ListRes = {
   requests?: FeatureRequestSummary[],
   error?: string | null,
};

const toSummary = (row: FeatureRequest): FeatureRequestSummary => ({
   ID: row.ID,
   account_id: row.account_id,
   request: row.request,
   context: row.context ?? null,
   status: row.status,
   matched_capability: row.matched_capability ?? null,
   created: row.get('createdAt') ? new Date(row.get('createdAt') as Date).toJSON() : null,
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
   await db.sync();
   await ensureAdminAccount();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized || !account) {
      return res.status(401).json({ error: error || 'Not authorized' });
   }
   if (req.method === 'POST') {
      return createRequest(req, res, account);
   }
   if (req.method === 'GET') {
      // ADMIN-only read of every account's requests. isAdminAccount is the admin sentinel id
      // but never a scoped share-key account, so a share key minted on the admin account cannot
      // read every tenant's feature requests here (belt: the share-key allowlist already denies
      // this route).
      if (!isAdminAccount(account)) {
         return res.status(403).json({ error: 'Admin access required.' });
      }
      return listRequests(req, res);
   }
   return res.status(405).json({ error: 'Method Not Allowed. Use POST or GET.' });
}

const createRequest = async (req: NextApiRequest, res: NextApiResponse<CreateRes>, account: Account) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const request = typeof body.request === 'string' ? body.request.trim() : '';
   const context = typeof body.context === 'string' ? body.context.trim() : '';

   if (!request) {
      return res.status(400).json({ error: 'request is required.' });
   }

   // SAFETY NET: never store a request for something s33k already does. crossCheckCapability is
   // the single source for the "does it exist?" check, so this gate cannot drift from the help
   // tool the LLM was told to confirm with first. A strong match pushes back WITHOUT storing.
   const match = crossCheckCapability(request);
   if (match.matched && match.capability) {
      return res.status(200).json({
         stored: false,
         matched: true,
         capability: { toolName: match.capability.toolName, title: match.capability.title },
         message: `This may already be supported via "${match.capability.toolName}" (${match.capability.title}). `
            + 'Confirm with the help tool that it does not cover your need before submitting.',
      });
   }

   try {
      const created = await FeatureRequest.create({
         account_id: account.ID,
         owner_id: ownerIdFor(account),
         request,
         context: context || null,
         status: 'open',
         matched_capability: null,
      });
      // Best-effort, graceful notification. Never fails the request when Resend is unconfigured.
      const notified = await notifyFeatureRequest({ accountId: account.ID, request, context });
      return res.status(201).json({
         stored: true,
         request_id: created.ID,
         matched: false,
         emailSent: notified.sent,
         message: 'Thanks. Your feature request was recorded for review.',
      });
   } catch (error) {
      console.log('[ERROR] Creating Feature Request: ', error);
      return res.status(400).json({ error: 'Error creating feature request.' });
   }
};

const listRequests = async (req: NextApiRequest, res: NextApiResponse<ListRes>) => {
   const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
   try {
      const where: Record<string, unknown> = {};
      if (statusFilter && STATUSES.includes(statusFilter)) {
         where.status = statusFilter;
      }
      const rows = await FeatureRequest.findAll({ where, order: [['ID', 'DESC']] });
      return res.status(200).json({ requests: rows.map(toSummary) });
   } catch (error) {
      console.log('[ERROR] Listing Feature Requests: ', error);
      return res.status(400).json({ error: 'Error Listing Feature Requests.' });
   }
};
