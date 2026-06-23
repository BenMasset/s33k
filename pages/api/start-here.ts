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
   buildDashboard, deriveDashboardState, DashboardGoal, DashboardKeyword,
} from '../../utils/dashboard';
import { selectSuggestedQuestions } from '../../utils/suggested-questions';
import { getInstallGuides } from '../../utils/install-guides';
import { findStrikingDistance, StrikingInput } from '../../utils/striking-distance';
import {
   computeSetupState, buildOnboarding, buildReady, InstallPayload, ReportTeasers,
   analyticsTeaser, seoTeaser, aeoTeaser, TEASER_UNAVAILABLE,
   OnboardingResult, ReadyResult,
} from '../../utils/start-here';
import { isAccountActive } from '../../utils/plans';
import { resolveBaseUrl } from '../../utils/baseUrl';
import { subscribeUrl } from '../../utils/subscribeLink';

// The billing banner start_here surfaces ABOVE everything else when a trial is ending soon or the
// account is locked. It is the highest-priority thing to say: a near-expiry or expired account must
// see "subscribe to keep your sites running" before any report. Additive: absent on a healthy active
// account, and never emitted in single-tenant (isAccountActive is always true with MULTI_TENANT off).
type BillingBanner = {
   state: 'trial-ending' | 'locked',
   headline: string,
   // The exact in-LLM steps to resolve it. Always billing_status then start_checkout.
   nextStep: string,
};

// The number of days-left at or below which a trial counts as "ending soon" for the banner.
const TRIAL_ENDING_SOON_DAYS = 3;

type StartHereResponse =
   | { mode: 'no-domain', message: string, billing?: BillingBanner, error?: string | null }
   | { mode: 'pick-domain', domains: string[], message: string, billing?: BillingBanner, error?: string | null }
   | (OnboardingResult & { billing?: BillingBanner, error?: string | null })
   | (ReadyResult & { billing?: BillingBanner, error?: string | null })
   | { billing?: BillingBanner, error: string | null };

// Compute the billing banner for the resolved account, or undefined when nothing needs saying.
// LOCKED (inactive: expired trial / canceled / past_due) takes priority over trial-ending. A
// trialing account with the trial ending in <= TRIAL_ENDING_SOON_DAYS days gets the "trial ending"
// banner. With MULTI_TENANT off / the admin sentinel, isAccountActive is always true and the trial
// columns are absent, so this returns undefined and the single-tenant path is byte-for-byte unchanged.
const billingBannerFor = (account: Account | null | undefined, baseUrl: string, now = Date.now()): BillingBanner | undefined => {
   if (!account) { return undefined; }
   // Prefer a one-click pre-authenticated pay link (utils/subscribeLink); fall back to naming the
   // in-LLM tool path when a link cannot be minted (no SECRET / baseUrl). Same link for both states:
   // a locked account subscribes to resume, a trial-ending account can subscribe early.
   const link = subscribeUrl(account, baseUrl);
   const nextStep = link
      ? `Subscribe and continue in one click: ${link}`
      : 'Call billing_status to see your status, then start_checkout to subscribe ($7/site/month).';
   if (!isAccountActive(account)) {
      return {
         state: 'locked',
         headline: 'Your free trial has ended. Subscribe to keep your sites running, your data and reports are safe.',
         nextStep,
      };
   }
   if (account.subscription_status === 'trialing' && account.trial_ends_at) {
      const endsMs = new Date(account.trial_ends_at).getTime();
      if (Number.isFinite(endsMs)) {
         const daysLeft = Math.ceil((endsMs - now) / 86400e3);
         if (daysLeft <= TRIAL_ENDING_SOON_DAYS) {
            const n = Math.max(daysLeft, 0);
            return {
               state: 'trial-ending',
               headline: `Your free trial ends in ${n} day${n === 1 ? '' : 's'}.`,
               nextStep,
            };
         }
      }
   }
   return undefined;
};

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

   // Highest-priority thing to surface: the billing banner. Computed once from the resolved account
   // and spread into every response below (additive; undefined on a healthy active / single-tenant
   // account, so it never appears there). Reads are never gated; this only annotates.
   const billing = billingBannerFor(account, resolveBaseUrl(req));
   const withBilling = <T extends object>(payload: T): T & { billing?: BillingBanner } => (
      billing ? { ...payload, billing } : payload
   );

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
            return res.status(200).json(withBilling({
               mode: 'no-domain' as const,
               message: 'You are not tracking any sites yet. Add a domain first (ask "start tracking <yourdomain.com>", '
                  + 'the onboard tool), then call start_here again.',
               error: null,
            }));
         }
         if (names.length > 1) {
            return res.status(200).json(withBilling({
               mode: 'pick-domain' as const,
               domains: names,
               message: `You track ${names.length} domains. Call start_here again with one of these.`,
               error: null,
            }));
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

      // Incomplete setup (including a not-owned/not-added domain): walk the user through INSTALL and
      // preview what each report UNLOCKS, then STOP. Dumping analytics on a half-set-up site is the
      // overwhelm start_here exists to avoid; but "here is how you put s33k on your site" belongs
      // inline, because installing the tracking script is the gating step for the analytics pillar.
      if (!setup.complete) {
         // NO-LEAK ownership gate (matches install_instructions): the per-domain tracking website id
         // is minted on a domain the caller OWNS, so we ONLY emit a real snippet when this caller owns
         // the domain AND it has a provisioned umami_website_id. We NEVER fall back to a shared env
         // website id, because that id belongs to whatever domain provisioned it (e.g. getmasset.com),
         // and emitting it here for a not-owned/not-yet-added domain would hand the caller another
         // site's real tracking tag.
         //
         // AUDIT FIX: when there is no owned id we now emit NO copyable snippet at all (snippet '').
         // The previous behavior printed a YOUR_SITE_ID placeholder snippet; an LLM (or user) could
         // paste that verbatim and it would silently collect nothing, since YOUR_SITE_ID is not a real
         // website id. A copyable-but-broken command is worse than no command. Instead the note tells
         // the user to add their site first so s33k mints their own real snippet, and the renderer
         // skips the paste line when the snippet is empty. start_here still never walls (it returns the
         // onboarding 200); it just refuses to hand out a snippet that would not work.
         const ownedWebsiteId = (owned && owned.umami_website_id) ? String(owned.umami_website_id) : '';
         const install: InstallPayload = ownedWebsiteId
            ? (() => {
               const guides = getInstallGuides(domain, ownedWebsiteId);
               return {
                  snippet: guides.snippet,
                  scriptUrl: guides.scriptUrl,
                  websiteId: guides.websiteId,
                  platforms: guides.platforms.map((p) => ({ platform: p.platform, steps: p.steps })),
                  note: 'Paste this one line into your site head. It is the gating step for the Analytics and AI-search '
                     + 'pillars. Ask install_instructions for steps on any specific platform.',
               };
            })()
            : {
               snippet: '',
               scriptUrl: '',
               websiteId: '',
               platforms: [],
               note: 'Add your site first (run onboard). s33k will then mint your own tracking snippet, and a later '
                  + 'start_here (or install_instructions) will hand you the ready-to-paste line with your real site id.',
            };
         const onboarding = buildOnboarding(domain, setup, install);
         return res.status(200).json(withBilling({ ...onboarding, error: null }));
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
      // RANK-PENDING signal: a freshly-tracked keyword is created updating:true and stays so until its
      // first Google check lands. parseKeywords drops the column, so read `updating` off the raw rows
      // here. Any pending keyword means the SEO teaser must say "first check running", never "0 on
      // page one" (a rank-pending keyword is being checked, not absent from the top 100).
      const anyRankPending = (keywordRows as Keyword[]).some((k) => {
         const p = k.get({ plain: true }) as { updating?: boolean };
         return Boolean(p.updating);
      });
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

      // ---- The 3 LIVE report teasers, computed in parallel, each degrading on its own. ----
      // The brief: show the 3 prebuilt reports WITH THE USER'S OWN NUMBERS. We already loaded
      // everything each teaser needs above (keywords for SEO, referralSources/summary for analytics
      // and AEO), so we compute from those rather than re-querying. Promise.allSettled means one
      // teaser throwing degrades ONLY itself to TEASER_UNAVAILABLE; the others and the whole response
      // never 500. The teaser composers are pure, so a rejection here would only come from a bad
      // input shape, but we still isolate each per the brief's never-500 guarantee.
      const [analyticsT, seoT, aeoT] = await Promise.allSettled([
         // Analytics teaser: total visitors (summary, or human sessions) + the biggest referral source.
         (async () => {
            const visitors = summaryData.error ? dashboard.headline.humanVisitors : (summaryData.visitors || 0);
            // The single biggest specific referral source (skip the direct/blank bucket so it is a
            // real "where did they come from" line). referralSources is already error-stripped.
            const named = referralSources
               .filter((s) => {
                  const n = String(s.name || '').trim().toLowerCase();
                  return n && n !== 'direct' && n !== '(direct)' && n !== '(none)' && n !== 'none';
               })
               .map((s) => ({ name: s.name, visitors: Number(s.unique_visitors ?? 0) }))
               .sort((a, b) => b.visitors - a.visitors);
            const top = named[0] || null;
            return analyticsTeaser({
               visitors,
               period,
               topSourceName: top ? top.name : null,
               topSourceVisitors: top ? top.visitors : 0,
            });
         })(),
         // SEO teaser: tracked count + on-page-one + striking-distance count, reusing the shared util.
         (async () => {
            const onPageOne = keywords.filter((k) => {
               const pos = Number(k.position) || 0;
               return pos > 0 && pos <= 10;
            }).length;
            const strikingInput: StrikingInput[] = keywords.map((k) => ({
               keyword: k.keyword,
               position: Number(k.position) || 0,
               url: String(k.url || ''),
               history: typeof k.history === 'string' ? k.history : JSON.stringify(k.history || {}),
            }));
            const striking = findStrikingDistance(strikingInput, 4, 30);
            return seoTeaser({
               keywordsTracked: keywords.length, onPageOne, strikingDistance: striking.length, rankPending: anyRankPending,
            });
         })(),
         // AEO teaser: AI visitors + AI share of referred traffic + top engine, from the dashboard's
         // already-computed AI-engine split and the referral totals.
         (async () => {
            const aiVisitors = dashboard.aiReferrals.data.totalAiVisitors;
            const allVisitors = referralSources.reduce((sum, s) => sum + Number(s.unique_visitors ?? 0), 0);
            const aiSharePct = allVisitors > 0 ? Math.round((aiVisitors / allVisitors) * 1000) / 10 : 0;
            const topEngineRow = dashboard.aiReferrals.data.byEngine[0] || null;
            return aeoTeaser({
               aiVisitors,
               aiSharePct,
               topEngine: topEngineRow ? topEngineRow.engine : null,
               topEngineVisitors: topEngineRow ? topEngineRow.visitors : 0,
            });
         })(),
      ]);

      const teasers: ReportTeasers = {
         analytics: analyticsT.status === 'fulfilled' ? analyticsT.value : TEASER_UNAVAILABLE,
         seo: seoT.status === 'fulfilled' ? seoT.value : TEASER_UNAVAILABLE,
         aeo: aeoT.status === 'fulfilled' ? aeoT.value : TEASER_UNAVAILABLE,
      };

      // Fold the dashboard's CONTEXTUAL suggested questions into the fixed ask-list (deduped in
      // buildReady), so the questions a user sees match what their actual data supports.
      const extraQuestions = selectSuggestedQuestions(deriveDashboardState(dashboard)).map((q) => q.question);

      const ready = buildReady({
         domain,
         period,
         humanVisitors: dashboard.headline.humanVisitors,
         aiReferredVisitors: dashboard.headline.aiReferredVisitors,
         topAction: dashboard.headline.topAction,
         teasers,
         extraQuestions,
         // GATHERING-state signals: a rank check still running, plus whether any conversion goal exists,
         // so the headline can lead with momentum and whatYouCanSee only promises conversion reporting
         // once a goal is defined. recentEvents already gated us into ready mode, so traffic is flowing.
         rankPending: anyRankPending,
         goalCount,
      });
      return res.status(200).json(withBilling({ ...ready, error: null }));
   } catch (error) {
      // Last-resort guard. The per-pillar catches mean we should never get here; if we do, still
      // return a usable ready payload (curated reports/see/ask, teasers degraded) rather than a 500,
      // honoring "never wall". buildReady gives the full ready shape with the unavailable fallbacks.
      console.log('[ERROR] Building start-here for ', requested || '(no domain)', error);
      const fallback = buildReady({
         domain: requested,
         period,
         humanVisitors: 0,
         aiReferredVisitors: 0,
         topAction: 'Ask dashboard for the full overview, or retry shortly.',
         teasers: { analytics: TEASER_UNAVAILABLE, seo: TEASER_UNAVAILABLE, aeo: TEASER_UNAVAILABLE },
      });
      return res.status(200).json(withBilling({ ...fallback, error: 'Error Building Start Here for this Domain.' }));
   }
};
