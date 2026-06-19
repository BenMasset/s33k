/*
 * ============================================================================
 * s33k START HERE ROUTE: the explicit guided entry point.
 * ============================================================================
 * GET /api/start-here?domain=&period=
 *
 * The first call a user should make when they connect their LLM to s33k and do
 * not know what to ask. It answers, in priority order:
 *   1. WHICH domain? (no domain + one tracked -> use it; many -> pick one; none -> add one)
 *   2. What is the SETUP state? (incomplete -> the next step and STOP, do not dump analytics)
 *   3. The single MOST IMPORTANT thing to do now (the dashboard top action)
 *   4. Where to look next (a SHORT curated list that always surfaces entry_pages,
 *      the "which pages did AI search land on" view).
 *
 * Reuses, never re-implements: the dashboard composer (utils/dashboard.ts) for the
 * headline + top action, and the same five setup counts onboarding-status.ts uses,
 * shaped by the pure utils/start-here.ts. This route is the thin loader + auth +
 * ownership gate; ALL shaping lives in the pure utils.
 *
 * RULES-BASED: no LLM call. Robust like briefing/dashboard: each provider pillar is
 * wrapped so a rejection degrades to a safe empty value instead of 500ing. The only
 * 4xx paths are auth (401) and wrong method (405). A missing/ambiguous/unowned domain
 * is answered as a structured 200 mode (pick-domain / no-domain / not-owned setup),
 * never an error, because "I do not know what to ask" must never hit a wall.
 * ============================================================================
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { Op } from 'sequelize';
import { ensureSynced } from '../../database/database';
import authorize from '../../utils/authorize';
import resolveDomainAccess from '../../utils/domain-access';
import { scopeWhere } from '../../utils/scope';
import Domain from '../../database/models/domain';
import Keyword from '../../database/models/keyword';
import S33kEvent from '../../database/models/s33kEvent';
import Goal from '../../database/models/goal';
import type Account from '../../database/models/account';
import parseKeywords from '../../utils/parseKeywords';
import { periodStartMs } from '../../utils/period';
import { sessionize, EventLike } from '../../utils/sessionize';
import {
   getAnalyticsProvider, NormalizedPage, ReferralSource, SummaryResult,
} from '../../utils/analytics';
import type { WebVitalRow } from '../../utils/web-vitals';
import {
   buildDashboard, DashboardGoal, DashboardKeyword,
} from '../../utils/dashboard';
import {
   computeSetupState, buildReady, NextStepPointer, ReadyResult,
} from '../../utils/start-here';

type StartHereResponse =
   | { mode: 'no-domain', message: string, error?: string | null }
   | { mode: 'pick-domain', domains: string[], message: string, error?: string | null }
   | {
      mode: 'setup',
      domain: string,
      percentComplete: number,
      nextStep: string | null,
      nextTool: string | null,
      message: string,
      error?: string | null,
   }
   | (ReadyResult & { error?: string | null })
   | { error: string | null };

export default async function handler(req: NextApiRequest, res: NextApiResponse<StartHereResponse>) {
   await ensureSynced();
   const { authorized, account, error } = await authorize(req, res);
   if (!authorized) { return res.status(401).json({ error: error || 'Not authorized' }); }
   if (req.method !== 'GET') { return res.status(405).json({ error: 'Method Not Allowed. Use GET.' }); }
   return getStartHere(req, res, account);
}

const getStartHere = async (req: NextApiRequest, res: NextApiResponse<StartHereResponse>, account?: Account | null) => {
   const requested = typeof req.query.domain === 'string' ? req.query.domain.trim() : '';
   const period = (typeof req.query.period === 'string' && req.query.period) ? req.query.period : '30d';

   try {
      // ---- Step 1: resolve WHICH domain to start on. --------------------------
      let domain = requested;
      if (!domain) {
         // No domain given: list the caller's own (scoped) domains and decide.
         const rows = await Domain.findAll({ where: { ...scopeWhere(account) } }).catch(() => [] as Domain[]);
         const names = (rows as Domain[])
            .map((d) => String((d.get({ plain: true }) as { domain?: string }).domain || ''))
            .filter(Boolean);
         if (names.length === 0) {
            return res.status(200).json({
               mode: 'no-domain',
               message: 'You are not tracking any sites yet. Add a domain first (ask "start tracking <yourdomain.com>", '
                  + 'the onboard tool), then call start_here again.',
               error: null,
            });
         }
         if (names.length > 1) {
            return res.status(200).json({
               mode: 'pick-domain',
               domains: names,
               message: `You track ${names.length} domains. Call start_here again with one of these.`,
               error: null,
            });
         }
         [domain] = names;
      }

      // ---- Ownership gate (same as every analytics route). --------------------
      // resolveDomainAccess returns the row only when the caller may read it; null = deny.
      // We answer a not-owned domain as a setup-style 200 (not a 403), because start_here is the
      // "I do not know what to ask" entry point and must always return a usable next move.
      const owned = await resolveDomainAccess(account, domain);

      // ---- Step 2: setup state. Reuse the same five counts onboarding-status reads. ----
      const scope = scopeWhere(account);
      const weekAgo = new Date(Date.now() - 7 * 86400e3).toJSON();
      const [keywordCount, recentEvents, goalCount] = await Promise.all([
         owned ? Keyword.count({ where: { domain, ...scope } }).catch(() => 0) : Promise.resolve(0),
         owned ? S33kEvent.count({ where: { domain, created: { [Op.gte]: weekAgo }, ...scope } }).catch(() => 0) : Promise.resolve(0),
         owned ? Goal.count({ where: { domain, ...scope } }).catch(() => 0) : Promise.resolve(0),
      ]);

      const setup = computeSetupState({
         owned: Boolean(owned), keywordCount, recentEvents, goalCount, domain,
      });

      // Incomplete setup (including a not-owned/not-added domain): give the one next step and STOP.
      // Dumping analytics on a half-set-up site is exactly the overwhelm start_here exists to avoid.
      if (!setup.complete) {
         const next = setup.nextStep;
         const message = next
            ? `Setup for ${domain} is ${setup.percentComplete}% done. Do this next: ${next.title}. ${next.detail} `
               + `Use ${next.nextTool}. Then call start_here again.`
            : `Setup for ${domain} is ${setup.percentComplete}% done. Call start_here again once you finish setup.`;
         return res.status(200).json({
            mode: 'setup',
            domain,
            percentComplete: setup.percentComplete,
            nextStep: next ? next.title : null,
            nextTool: next ? next.nextTool : null,
            message,
            error: null,
         });
      }

      // ---- Step 3 + 4: ready. Compose the dashboard for the headline + top action. ----
      // Reuse buildDashboard rather than re-deriving any analytics. Each provider pillar is wrapped
      // so a rejection degrades to a safe empty value (never a 500), exactly like dashboard.ts.
      const provider = getAnalyticsProvider();
      const startISO = new Date(periodStartMs(period, Date.now())).toJSON();
      const [keywordRows, eventRows, webVitalRows, goalRows, traffic, referrals, summary] = await Promise.all([
         Keyword.findAll({ where: { domain, ...scope } }).catch(() => [] as Keyword[]),
         S33kEvent.findAll({
            where: { domain, created: { [Op.gte]: startISO }, ...scope },
            attributes: ['id', 'session', 'source', 'is_bot', 'device', 'country', 'page', 'type', 'created'],
            order: [['created', 'ASC']],
         }).catch(() => [] as S33kEvent[]),
         S33kEvent.findAll({
            where: { domain, type: 'webvital', is_bot: false, created: { [Op.gte]: startISO }, ...scope },
            raw: true,
         }).catch(() => [] as unknown as WebVitalRow[]),
         Goal.findAll({ where: { domain, ...scope } }).catch(() => [] as Goal[]),
         provider.getPageTraffic(domain, period).catch((e) => ({ pages: [], error: String(e) })),
         provider.getReferralSources(domain, period).catch((e) => ({ sources: [], error: String(e) })),
         provider.getSummary(domain, period).catch((e) => ({
            pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: String(e),
         })),
      ]);

      const keywords: DashboardKeyword[] = parseKeywords(
         (keywordRows as Keyword[]).map((k) => k.get({ plain: true })),
      ).map((k) => ({
         keyword: k.keyword, position: k.position, url: k.url, target_page: k.target_page, history: k.history,
      }));
      const sessions = sessionize((eventRows as S33kEvent[]).map((r) => r.get({ plain: true }) as EventLike));
      const goals: DashboardGoal[] = (goalRows as Goal[]).map((g) => {
         const p = g.get({ plain: true }) as Record<string, unknown>;
         return {
            ID: Number(p.ID),
            name: String(p.name),
            kind: String(p.kind),
            match_value: String(p.match_value),
            match_page: (p.match_page as string) || null,
            match_mode: String(p.match_mode || 'prefix'),
            value: typeof p.value === 'number' ? p.value : null,
         };
      });
      const trafficPages: NormalizedPage[] = (traffic as { pages: NormalizedPage[] }).pages || [];
      const referralSources: ReferralSource[] = (referrals as { sources: ReferralSource[] }).sources || [];
      const summaryData = summary as SummaryResult;

      const dashboard = buildDashboard({
         domain,
         period,
         keywords,
         sessions,
         summary: summaryData.error ? null : summaryData,
         trafficPages,
         referralSources,
         webVitalRows: webVitalRows as unknown as WebVitalRow[],
         goals,
         errors: {
            summary: summaryData.error,
            traffic: (traffic as { error?: string | null }).error,
            referrals: (referrals as { error?: string | null }).error,
         },
      });

      const ready = buildReady({
         domain,
         period,
         humanVisitors: dashboard.headline.humanVisitors,
         aiReferredVisitors: dashboard.headline.aiReferredVisitors,
         topAction: dashboard.headline.topAction,
      });
      return res.status(200).json({ ...ready, error: null });
   } catch (error) {
      // Last-resort guard. The per-pillar catches mean we should never get here; if we do, still
      // return a usable next move (the curated pointers) rather than a 500, honoring "never wall".
      console.log('[ERROR] Building start-here for ', requested || '(no domain)', error);
      const nextSteps: NextStepPointer[] = [
         { label: 'See which pages AI search lands on', tool: 'entry_pages' },
         { label: 'Your quickest SEO wins', tool: 'striking_distance' },
         { label: 'Full cross-pillar overview', tool: 'dashboard' },
      ];
      return res.status(200).json({
         mode: 'ready',
         domain: requested,
         headline: `Could not load a full overview for ${requested || 'your site'} this period.`,
         topAction: 'Ask dashboard for the full overview, or retry shortly.',
         nextSteps,
         rendered: '=== START HERE ===\nCould not load a full overview right now. Try dashboard, or retry shortly.',
         error: 'Error Building Start Here for this Domain.',
      });
   }
};
