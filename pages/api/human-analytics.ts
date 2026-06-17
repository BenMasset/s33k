import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import db from '../../database/database';
import authorize from '../../utils/authorize';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import S33kEvent from '../../database/models/s33kEvent';
import type Account from '../../database/models/account';

// GET /api/human-analytics?domain=...&period=30d[&includeBots=true]
//
// HUMAN-ONLY traffic analytics, computed from s33k's OWN first-party pageview events (not Umami).
// Each pageview row carries an is_bot flag set at ingest from the source IP (utils/datacenter-ip),
// so this endpoint can do the one thing a JS pageview tracker (Umami, GA) cannot: exclude the
// datacenter/hosting traffic that executes JavaScript but is not a person. Bots are filtered by
// default; pass includeBots=true to see the raw (with-bots) numbers for comparison.
//
// What it reports, all from pageview rows grouped by anonymous session:
//   - visitors (distinct sessions), pageviews, pages/session
//   - bounce rate (sessions with exactly one pageview)
//   - entry pages (each session's first pageview) with share
//   - exit pages WITH exit rate (each session's last pageview; exit rate = exits / pageviews of
//     that page), the metric the Umami-backed summary cannot produce
//   - botShare: how many visitors were filtered as datacenter/bot, for transparency.

type EntryPageRow = { page: string, entries: number, sharePct: number };
type ExitPageRow = { page: string, exits: number, pageviews: number, exitRatePct: number };

type HumanAnalyticsResponse = {
   domain?: string,
   period?: string,
   includesBots?: boolean,
   summary?: {
      visitors: number,
      pageviews: number,
      bounceRatePct: number,
      pagesPerSession: number,
      botVisitorsFiltered: number,
      botSharePct: number,
   },
   entryPages?: EntryPageRow[],
   exitPages?: ExitPageRow[],
   note?: string,
   error?: string | null,
};

// Parse a period string ("30d" / "24h" / "7d") into a start timestamp (ms). Defaults to 30 days.
const periodStartMs = (period: string): number => {
   const m = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   const now = Date.now();
   if (!m) { return now - 30 * 24 * 3600 * 1000; }
   const n = parseInt(m[1], 10);
   const unitMs = { h: 3600e3, d: 86400e3, w: 604800e3, m: 2592000e3 }[m[2].toLowerCase()] || 86400e3;
   return now - n * unitMs;
};

export default async function handler(req: NextApiRequest, res: NextApiResponse<HumanAnalyticsResponse>) {
   await db.sync();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) {
      return res.status(401).json({ error });
   }
   if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method Not Allowed. Use GET.' });
   }
   return getHumanAnalytics(req, res, account);
}

const getHumanAnalytics = async (req: NextApiRequest, res: NextApiResponse<HumanAnalyticsResponse>, account?: Account | null) => {
   if (!req.query.domain || typeof req.query.domain !== 'string') {
      return res.status(400).json({ error: 'Domain is Required!' });
   }
   const domain = req.query.domain as string;
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';
   const includeBots = req.query.includeBots === 'true';

   // Ownership gate before any read (same invariant as every analytics route).
   const owned = await Domain.findOne({ where: { domain, ...scopeWhere(account) } });
   if (!owned) {
      return res.status(403).json({ error: 'Domain not found for this account' });
   }

   try {
      const startISO = new Date(periodStartMs(period)).toJSON();
      // Pull pageview rows in the window (both human and bot, so we can report what was filtered).
      const rows = await S33kEvent.findAll({
         where: { domain, type: 'pageview', created: { [Op.gte]: startISO }, ...scopeWhere(account) },
         attributes: ['session', 'page', 'is_bot', 'created'],
         order: [['created', 'ASC']],
      });

      type Row = { session: string, page: string, is_bot: boolean, created: string };
      const all: Row[] = rows.map((r) => r.get({ plain: true }) as Row);
      const humanRows = all.filter((r) => !r.is_bot);
      const consider = includeBots ? all : humanRows;

      // Distinct visitors (sessions), split human vs bot, for the botShare transparency line.
      const sessionsOf = (rs: Row[]) => new Set(rs.map((r) => r.session || '')).size;
      const humanVisitors = sessionsOf(humanRows);
      const botVisitors = sessionsOf(all.filter((r) => r.is_bot));
      const totalVisitors = humanVisitors + botVisitors;
      const botSharePct = totalVisitors > 0 ? Math.round((1000 * botVisitors) / totalVisitors) / 10 : 0;

      // Group the considered rows by session, preserving order (rows came back created ASC).
      const bySession = new Map<string, Row[]>();
      for (const r of consider) {
         const key = r.session || `anon-${r.created}`;
         if (!bySession.has(key)) { bySession.set(key, []); }
         (bySession.get(key) as Row[]).push(r);
      }

      const sessionCount = bySession.size;
      const pageviews = consider.length;
      let bounced = 0;
      const entryCounts = new Map<string, number>();
      const exitCounts = new Map<string, number>();
      const pageviewCounts = new Map<string, number>();
      for (const r of consider) { pageviewCounts.set(r.page, (pageviewCounts.get(r.page) || 0) + 1); }
      for (const session of bySession.values()) {
         if (session.length === 1) { bounced += 1; }
         const entry = session[0].page;
         const exit = session[session.length - 1].page;
         entryCounts.set(entry, (entryCounts.get(entry) || 0) + 1);
         exitCounts.set(exit, (exitCounts.get(exit) || 0) + 1);
      }

      const bounceRatePct = sessionCount > 0 ? Math.round((1000 * bounced) / sessionCount) / 10 : 0;
      const pagesPerSession = sessionCount > 0 ? Math.round((100 * pageviews) / sessionCount) / 100 : 0;

      const entryPages: EntryPageRow[] = Array.from(entryCounts.entries())
         .map(([page, entries]) => ({ page, entries, sharePct: sessionCount > 0 ? Math.round((1000 * entries) / sessionCount) / 10 : 0 }))
         .sort((a, b) => b.entries - a.entries)
         .slice(0, 25);

      const exitPages: ExitPageRow[] = Array.from(exitCounts.entries())
         .map(([page, exits]) => {
            const pv = pageviewCounts.get(page) || exits;
            return { page, exits, pageviews: pv, exitRatePct: pv > 0 ? Math.round((1000 * exits) / pv) / 10 : 0 };
         })
         .sort((a, b) => b.exits - a.exits)
         .slice(0, 25);

      const note = pageviews === 0
         ? 'No first-party pageviews recorded yet. Install the s33k.js tracking script on the site so human-only '
            + 'traffic, bounce, and exit rate can be computed from IP-classified pageviews.'
         : `Human-only by default (datacenter/bot pageviews excluded via is_bot). ${botVisitors} bot visitor(s) `
            + `filtered (${botSharePct}% of all). Pass includeBots=true to see raw numbers.`;

      return res.status(200).json({
         domain,
         period,
         includesBots: includeBots,
         summary: {
            visitors: includeBots ? totalVisitors : humanVisitors,
            pageviews,
            bounceRatePct,
            pagesPerSession,
            botVisitorsFiltered: botVisitors,
            botSharePct,
         },
         entryPages,
         exitPages,
         note,
         error: null,
      });
   } catch (error) {
      console.log('[ERROR] Building Human Analytics for ', domain, error);
      return res.status(400).json({ error: 'Error Building Human Analytics for this Domain.' });
   }
};
