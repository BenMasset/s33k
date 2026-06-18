import type { NextApiRequest } from 'next';

// The single source of truth for which routes an API key (the legacy global key or a
// per-tenant key) is allowed to call. Cookie/UI sessions are NOT restricted by this list.
//
// This lives in its own dependency-free module on purpose: verifyUser imports it, and
// verifyUser must stay lightweight (no transitive database-model imports), otherwise any
// test or code path that loads a route using verifyUser would pull sequelize into scope.
export const allowedApiRoutes = [
   'GET:/api/keyword',
   'GET:/api/keywords',
   'PUT:/api/keywords',
   'DELETE:/api/keywords',
   'GET:/api/domains',
   'POST:/api/keywords',
   'POST:/api/domains',
   'DELETE:/api/domains',
   'POST:/api/refresh',
   'POST:/api/cron',
   'POST:/api/notify',
   'POST:/api/searchconsole',
   'GET:/api/searchconsole',
   'DELETE:/api/searchconsole',
   'GET:/api/searchconsole/connect',
   'GET:/api/insight',
   'GET:/api/insights',
   'GET:/api/scoreboard',
   'GET:/api/entry-pages',
   'GET:/api/ai-referrals',
   'GET:/api/summary',
   'GET:/api/human-traffic',
   'GET:/api/human-analytics',
   'GET:/api/goals',
   'POST:/api/goals',
   'PUT:/api/goals',
   'DELETE:/api/goals',
   'GET:/api/goal-analytics',
   'GET:/api/conversion-attribution',
   'GET:/api/causal-links',
   'GET:/api/suggest-goals',
   'GET:/api/onboarding-status',
   'GET:/api/striking-distance',
   'GET:/api/channel-report',
   'GET:/api/live-view',
   'GET:/api/funnel',
   'GET:/api/entry-page-report',
   'GET:/api/period-compare',
   'GET:/api/site-audit',
   'GET:/api/cannibalization',
   'GET:/api/content-gap',
   'GET:/api/content-performance',
   'GET:/api/weekly-digest',
   'GET:/api/executive-summary',
   'GET:/api/seo-report',
   'GET:/api/aeo-report',
   'GET:/api/aeo-roi',
   'GET:/api/campaign-report',
   'GET:/api/dashboard',
   'GET:/api/portfolio',
   'GET:/api/competitor-visibility',
   'GET:/api/segments',
   'POST:/api/segments',
   'DELETE:/api/segments',
   'GET:/api/segment-analytics',
   'GET:/api/breakdown',
   'GET:/api/timeseries',
   'GET:/api/events',
   'GET:/api/engagement',
   'POST:/api/crawler-hit',
   'GET:/api/ai-crawlers',
   'GET:/api/ai-visibility',
   'GET:/api/top-clicks',
   'GET:/api/form-submissions',
   'GET:/api/scroll-depth',
   'GET:/api/page-engagement',
   'GET:/api/web-vitals',
   'GET:/api/conversions',
   'GET:/api/discover',
   'POST:/api/onboard',
   'GET:/api/install-instructions',
   'GET:/api/briefing',
   'GET:/api/alerts',
   'GET:/api/daily-brief',
   'POST:/api/account',
   'GET:/api/account',
   'POST:/api/account-key',
   'DELETE:/api/account-key',
   'GET:/api/me',
   'GET:/api/export',
   'DELETE:/api/account-data',
   'GET:/api/security',
   'GET:/api/help',
   'POST:/api/invite',
   'GET:/api/invite',
   'GET:/api/waitlist',
   'POST:/api/feature-request',
   'GET:/api/feature-request',
   'POST:/api/share',
   'GET:/api/share',
   'DELETE:/api/share',
];

export const isAllowedApiRoute = (req: NextApiRequest): boolean => Boolean(
   req.url && req.method
   && allowedApiRoutes.includes(`${req.method}:${req.url.replace(/\?(.*)/, '')}`),
);

// scopedKeyAllowedRoutes is the POSITIVE ALLOWLIST for a read-only per-domain SHARE key
// (ApiKey.scoped_domain set). It is the curated set of GET routes that genuinely gate on
// req.query.domain via resolveDomainAccess(account, <that domain>) BEFORE reading any pillar
// data, and whose reads are keyed by that one domain. A share key may call ONLY these; every
// other route is DENIED, even when the share key presents its own ?domain=.
//
// Why an allowlist and not a blacklist-by-presence: the previous gate let a scoped key through
// as long as ?domain= equaled its scoped domain, but several routes (export, portfolio, domains
// GET, account, me, invite, ...) IGNORE req.query.domain and return account- or instance-wide
// data via scopeWhere(account). A share key minted on the admin account (owner_id null => admin)
// inherits admin scope, so scopeWhere returns {} and those routes dump EVERYTHING. The fix is to
// allow a scoped key only on routes proven to gate per-domain, and to strip admin identity from
// scoped keys (see resolveAccount.ts / authorize.ts). This file stays dependency-free (no model
// imports) on purpose, same reason as allowedApiRoutes above.
//
// DERIVATION (each entry verified by opening the route): every route below is GET-only, reads its
// domain from req.query.domain, calls resolveDomainAccess(account, domain) (returning 403 when the
// caller does not own it) BEFORE any pillar read, and keys its data query on that single domain.
// keyword.ts is deliberately EXCLUDED: its GET looks a keyword up by ID with only scopeWhere(account)
// and never gates by domain, so an admin-scoped share key would read any keyword across all domains.
// The cross-domain / account / instance routes (export, portfolio, domains, domain, account,
// account-key, me, invite, waitlist, feature-request, account-data, onboard, refresh, notify,
// crawler-hit, share, searchconsole/connect, adwords, ideas, settings, dbmigrate, clearfailed, cron,
// collect, volume, login, logout) are EXCLUDED. competitor-visibility, executive-summary,
// weekly-digest, and onboarding-status DO gate per-domain but are intentionally NOT included here:
// they are outside the curated share-key surface, fail-closed until explicitly added.
export const scopedKeyAllowedRoutes: string[] = [
   'GET:/api/dashboard',
   'GET:/api/human-analytics',
   'GET:/api/summary',
   'GET:/api/channel-report',
   'GET:/api/ai-referrals',
   'GET:/api/ai-crawlers',
   'GET:/api/ai-visibility',
   'GET:/api/aeo-report',
   'GET:/api/aeo-roi',
   'GET:/api/seo-report',
   'GET:/api/scoreboard',
   'GET:/api/striking-distance',
   'GET:/api/insight',
   'GET:/api/searchconsole',
   'GET:/api/entry-page-report',
   'GET:/api/entry-pages',
   'GET:/api/human-traffic',
   'GET:/api/conversions',
   'GET:/api/goal-analytics',
   'GET:/api/conversion-attribution',
   'GET:/api/causal-links',
   'GET:/api/campaign-report',
   'GET:/api/segment-analytics',
   'GET:/api/web-vitals',
   'GET:/api/funnel',
   'GET:/api/live-view',
   'GET:/api/period-compare',
   'GET:/api/content-performance',
   'GET:/api/page-engagement',
   'GET:/api/scroll-depth',
   'GET:/api/top-clicks',
   'GET:/api/form-submissions',
   'GET:/api/breakdown',
   'GET:/api/timeseries',
   'GET:/api/events',
   'GET:/api/engagement',
   'GET:/api/content-gap',
   'GET:/api/cannibalization',
   'GET:/api/site-audit',
   'GET:/api/discover',
   'GET:/api/briefing',
   'GET:/api/insights',
   'GET:/api/alerts',
   'GET:/api/daily-brief',
   'GET:/api/suggest-goals',
   'GET:/api/keywords',
   'GET:/api/goals',
   'GET:/api/segments',
   'GET:/api/install-instructions',
];

// isScopedKeyAllowedRoute returns true ONLY for a GET request whose route is in the positive
// scoped-key allowlist. A non-GET method, a missing method/url, or any route not in the list
// returns false (DENY). authorize() additionally requires the canonical ?domain= to equal the
// key's scoped_domain, so this gate plus the domain-equality check together confine a share key
// to per-domain reads of exactly its one domain.
export const isScopedKeyAllowedRoute = (req: NextApiRequest): boolean => Boolean(
   req.url && req.method === 'GET'
   && scopedKeyAllowedRoutes.includes(`GET:${req.url.replace(/\?(.*)/, '')}`),
);
