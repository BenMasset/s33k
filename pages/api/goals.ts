import type { NextApiRequest, NextApiResponse } from 'next';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere, ownerIdFor } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import type Account from '../../database/models/account';

// /api/goals  -  CRUD for NAMED conversion goals (see database/models/goal.ts).
//   GET    ?domain=            list a domain's goals
//   POST   { domain, name, kind, matchValue, matchPage?, matchMode? }   create a goal
//   DELETE ?id=                delete a goal
// Every operation is ownership-gated (scopeWhere) so a tenant only ever touches its own goals.

type GoalsResponse = { goals?: Record<string, unknown>[], goal?: Record<string, unknown>, removed?: number, error?: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<GoalsResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method === 'GET') { return listGoals(req, res, account); }
   if (req.method === 'POST') { return createGoal(req, res, account); }
   if (req.method === 'DELETE') { return deleteGoal(req, res, account); }
   return res.status(405).json({ error: 'Method Not Allowed.' });
}

const listGoals = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const domain = typeof req.query.domain === 'string' ? req.query.domain : '';
   try {
      const where = domain ? { domain, ...scopeWhere(account) } : { ...scopeWhere(account) };
      const goals = await Goal.findAll({ where });
      return res.status(200).json({ goals: goals.map((g) => g.get({ plain: true }) as Record<string, unknown>) });
   } catch (error) {
      console.log('[ERROR] Listing goals: ', error);
      return res.status(400).json({ error: 'Error Listing Goals.' });
   }
};

const createGoal = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const body = (req.body && typeof req.body === 'object') ? req.body : {};
   const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
   const name = typeof body.name === 'string' ? body.name.trim() : '';
   const kind = body.kind === 'event' ? 'event' : 'page_reached';
   const matchValue = typeof body.matchValue === 'string' ? body.matchValue.trim() : '';
   const matchPage = typeof body.matchPage === 'string' && body.matchPage.trim() ? body.matchPage.trim() : null;
   const matchMode = body.matchMode === 'exact' ? 'exact' : 'prefix';

   if (!domain || !name || !matchValue) {
      return res.status(400).json({ error: 'domain, name, and matchValue are required.' });
   }
   try {
      // Ownership gate: the caller must own the domain before defining a goal on it.
      const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
      if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

      const goal = await Goal.create({
         domain,
         owner_id: ownerIdFor(account),
         name,
         kind,
         match_value: matchValue,
         match_page: kind === 'event' ? matchPage : null,
         match_mode: matchMode,
         created: new Date().toJSON(),
      });
      return res.status(201).json({ goal: goal.get({ plain: true }) as Record<string, unknown> });
   } catch (error) {
      console.log('[ERROR] Creating goal: ', error);
      return res.status(400).json({ error: 'Error Creating Goal.' });
   }
};

const deleteGoal = async (req: NextApiRequest, res: NextApiResponse<GoalsResponse>, account?: Account | null) => {
   const id = typeof req.query.id === 'string' ? parseInt(req.query.id, 10) : NaN;
   if (!Number.isFinite(id)) { return res.status(400).json({ error: 'Goal id is required.' }); }
   try {
      const removed = await Goal.destroy({ where: { ID: id, ...scopeWhere(account) } });
      return res.status(200).json({ removed });
   } catch (error) {
      console.log('[ERROR] Deleting goal: ', error);
      return res.status(400).json({ error: 'Error Deleting Goal.' });
   }
};
