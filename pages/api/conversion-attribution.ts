import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Goal from '../../database/models/goal';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';
import { periodStartMs } from '../../utils/period';
import { sessionize, applyFilters, parseSegmentFilters, EventLike, GoalDef } from '../../utils/sessionize';
import { attributeConversions, AttribKeyword } from '../../utils/conversion-attribution';

// GET /api/conversion-attribution?domain=&goal=|goalId=&period=[&filters]
//
// The merged-pillar superpower: for a named goal, attribute its conversions across all three
// channels at once, by acquisition source (incl. AI), by tracked keyword (credit each keyword's
// page with the conversions it drove), and surface the money moves (rank-not-converting,
// converts-not-ranking, ai-outconverts-search). Human-only by default; composable filters apply.

type Resp = {
   domain?: string,
   period?: string,
   goal?: { id: number, name: string },
   attribution?: ReturnType<typeof attributeConversions>,
   note?: string,
   error?: string | null,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<Resp>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getAttribution(req, res, account);
}

const getAttribution = async (req: NextApiRequest, res: NextApiResponse<Resp>, account?: Account | null) => {
   const q = req.query;
   const domain = typeof q.domain === 'string' ? q.domain : '';
   if (!domain) { return res.status(400).json({ error: 'Domain is Required!' }); }
   const period = (typeof q.period === 'string' && q.period) ? q.period : '30d';

   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) { return res.status(403).json({ error: 'Domain not found for this account' }); }

   try {
      const goalWhere: Record<string, unknown> = { domain, ...scopeWhere(account) };
      if (typeof q.goalId === 'string' && q.goalId.trim()) {
         goalWhere.ID = parseInt(q.goalId, 10);
      } else if (typeof q.goal === 'string' && q.goal.trim()) {
         goalWhere.name = q.goal.trim();
      }
      const goalRow = await Goal.findOne({ where: goalWhere });
      if (!goalRow) { return res.status(404).json({ error: 'Goal not found. Create it first with create_goal, or list goals.' }); }
      const g = goalRow.get({ plain: true }) as Record<string, unknown>;
      const goal: GoalDef = {
         kind: g.kind === 'event' ? 'event' : 'page_reached',
         matchValue: String(g.match_value),
         matchPage: (g.match_page as string) || null,
         matchMode: g.match_mode === 'exact' ? 'exact' : 'prefix',
      };

      const includeBots = q.includeBots === 'true';
      const filters = { humanOnly: !includeBots, ...parseSegmentFilters(q as Record<string, unknown>) };

      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const [eventRows, keywordRows] = await Promise.all([
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scopeWhere(account) },
            attributes: ['session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }),
         Keyword.findAll({ where: { domain, ...scopeWhere(account) }, attributes: ['keyword', 'position', 'target_page'] }),
      ]);

      const sessions = applyFilters(sessionize(eventRows.map((r) => r.get({ plain: true }) as EventLike)), filters);
      const keywords: AttribKeyword[] = keywordRows.map((k) => {
         const p = k.get({ plain: true }) as Record<string, unknown>;
         return { keyword: String(p.keyword), position: Number(p.position) || 0, targetPage: String(p.target_page || '') };
      });

      const attribution = attributeConversions(sessions, goal, keywords);
      const note = attribution.totalSessions === 0
         ? 'No first-party sessions in this window/filter yet. Install the s33k.js tracking script so traffic and conversions flow in.'
         : `${attribution.conversions} conversion(s) attributed across ${attribution.byChannel.length} channel(s) and `
            + `${attribution.byKeyword.length} keyword-bearing page(s). Human-only by default.`;

      return res.status(200).json({
         domain,
         period,
         goal: { id: g.ID as number, name: String(g.name) },
         attribution,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Conversion Attribution for ', domain, error);
      return res.status(400).json({ error: 'Error Building Conversion Attribution for this Domain.' });
   }
};
