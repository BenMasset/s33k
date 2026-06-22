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
   'GET:/api/start-here',
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
   'GET:/api/ai-visibility',
   'GET:/api/top-clicks',
   'GET:/api/form-submissions',
   'GET:/api/scroll-depth',
   'GET:/api/page-engagement',
   'GET:/api/web-vitals',
   'GET:/api/conversions',
   'GET:/api/prompt-checks',
   'POST:/api/prompt-checks',
   'DELETE:/api/prompt-checks',
   'POST:/api/prompt-record',
   'GET:/api/prompt-radar',
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
   // Billing (Stripe subscription + 14-day no-CC trial). These three are AUTHED via authorize().
   // The webhook (/api/billing/webhook) is deliberately ABSENT: it is PUBLIC + Stripe-signature
   // gated (same pattern as the GSC OAuth callback), and these are NOT added to
   // scopedKeyAllowedRoutes, so a read-only share key can never reach billing.
   'POST:/api/billing/checkout',
   'POST:/api/billing/portal',
   'GET:/api/billing/status',
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
// start-here.ts has a no-domain branch (it can LIST the caller's domains when ?domain= is omitted), but
// that branch is UNREACHABLE for a scoped share key: authorize() requires a scoped key's canonical
// ?domain= to equal its scoped_domain BEFORE the route runs, so a scoped key always arrives with its one
// domain and only ever hits the owned-domain path (resolveDomainAccess gate, then per-domain reads).
// keyword.ts is deliberately EXCLUDED: its GET looks a keyword up by ID with only scopeWhere(account)
// and never gates by domain, so an admin-scoped share key would read any keyword across all domains.
// The cross-domain / account / instance routes (export, portfolio, domains, domain, account,
// account-key, me, invite, waitlist, feature-request, account-data, onboard, refresh, notify,
// share, searchconsole/connect, adwords, ideas, settings, dbmigrate, clearfailed, cron,
// collect, volume, login, logout) are EXCLUDED. onboarding-status DOES gate per-domain but is
// intentionally NOT included: it is an owner-facing setup read (install snippet + setup state) of
// little value to a read-only viewer, and start-here (allowlisted) already gives a shared viewer the
// setup/ready picture. competitor-visibility, executive-summary, and weekly-digest were each verified
// to follow the same per-domain gate as the routes below (authorize -> resolveDomainAccess 403 before
// any read, every query keyed on the one domain via scopeWhere) and are now EXPLICITLY ADDED: they are
// read-only, single-domain reports a shared analytics viewer should see, and leaving them out only
// surfaced a confusing 401 on tools the MCP surface already advertises.
//
// THE STATIC PRODUCT-INFO EXCEPTION: /api/security and /api/help are added at the BOTTOM of the list
// but do NOT follow the per-domain-gate derivation above, on purpose. They are not per-domain reads at
// all: each returns a FIXED, account-independent payload (trust facts / product knowledge), identical
// for every caller, reading no req.query.domain and no tenant row. They are safe for a share key for
// the same reason they would be safe for the public, the "is it tenant data?" question is no, not the
// "does it gate per-domain?" question. See their entries below and each route's header comment.
export const scopedKeyAllowedRoutes: string[] = [
   'GET:/api/start-here',
   'GET:/api/dashboard',
   'GET:/api/human-analytics',
   'GET:/api/summary',
   'GET:/api/channel-report',
   'GET:/api/ai-referrals',
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
   'GET:/api/prompt-radar',
   'GET:/api/prompt-checks',
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
   // Read-only, single-domain report bundles. Each gates per-domain (authorize ->
   // resolveDomainAccess 403 before any read; every query keyed on the one domain) exactly like the
   // routes above, verified by opening each route. Added so a read-only share key does not hit a
   // confusing 401 on prebuilt-report tools the MCP surface advertises (weekly_digest,
   // executive_summary, competitor_visibility).
   'GET:/api/weekly-digest',
   'GET:/api/executive-summary',
   'GET:/api/competitor-visibility',
   // STATIC PRODUCT-INFO routes (NOT tenant-scoped). These two read NOTHING from any account:
   // /api/security returns the fixed trust facts (utils/securityFacts.ts) and /api/help returns the
   // fixed product knowledge (utils/knowledge.ts), the SAME response for every caller. Neither reads
   // req.query.domain, calls resolveDomainAccess, or touches a Domain/Keyword/event/account row, so
   // adding them widens the share-key surface ONLY to "what is this product and is it safe", with zero
   // tenant-data exposure. They are authed purely to travel the Bearer-key path (see each route's
   // header comment). Added so a read-only shared viewer can read the product/trust info the MCP
   // surface advertises (security_facts, help) instead of hitting a confusing 401.
   'GET:/api/security',
   'GET:/api/help',
];

// scopedKeyDomainlessRoutes is the SMALL subset of the allowlist that returns STATIC, account-
// independent product info and so does NOT take a ?domain= at all. authorize() normally requires a
// scoped share key to present a ?domain= equal to its scoped_domain (the per-domain gate), but these
// routes ignore the domain entirely and read no tenant row, so requiring a domain on them only forces
// a meaningless query param. Keeping this as an EXPLICIT, named, tiny list (rather than skipping the
// domain check for every allowlisted route) means the domain-equality gate still applies to every
// per-domain data route; only proven-domain-independent static info is exempt. Anything added here
// MUST return the same response for every caller (no tenant data, no req.query.domain read).
export const scopedKeyDomainlessRoutes: string[] = [
   'GET:/api/security',
   'GET:/api/help',
];

// isScopedKeyAllowedRoute returns true ONLY for a GET request whose route is in the positive
// scoped-key allowlist. A non-GET method, a missing method/url, or any route not in the list
// returns false (DENY). authorize() additionally requires the canonical ?domain= to equal the
// key's scoped_domain (EXCEPT for isScopedKeyDomainlessRoute static routes), so this gate plus the
// domain-equality check together confine a share key to per-domain reads of exactly its one domain.
export const isScopedKeyAllowedRoute = (req: NextApiRequest): boolean => Boolean(
   req.url && req.method === 'GET'
   && scopedKeyAllowedRoutes.includes(`GET:${req.url.replace(/\?(.*)/, '')}`),
);

// isScopedKeyDomainlessRoute is true ONLY for a GET request to one of the static product-info routes
// that take no domain. Used by authorize() to skip the domain-equality check for these (and only
// these) routes. Every entry is also in scopedKeyAllowedRoutes, so this can only RELAX the domain
// requirement on already-allowed static routes, never allow a new route.
export const isScopedKeyDomainlessRoute = (req: NextApiRequest): boolean => Boolean(
   req.url && req.method === 'GET'
   && scopedKeyDomainlessRoutes.includes(`GET:${req.url.replace(/\?(.*)/, '')}`),
);
