/**
 * Umami Analytics integration (self-hosted Umami v2).
 *
 * Umami is the standalone, owned analytics engine for s33k: open source (MIT),
 * self-hosted, no third-party SaaS in the data path. This provider reads
 * per-page pageview metrics from a self-hosted Umami instance and normalizes
 * them for the scoreboard join.
 *
 * Implemented against the official Umami v2 REST API docs
 * (https://docs.umami.is/docs/api):
 *   - Auth (self-hosted): POST /api/auth/login  with { username, password }
 *       returns { token, user }. The token is sent as `Authorization: Bearer <token>`.
 *       (Umami Cloud uses a generated API key instead; for parity we also accept
 *       a pre-issued key via UMAMI_API_KEY and send it as the Bearer token.)
 *   - Websites:  GET /api/websites  returns { data: [{ id, name, domain, ... }], ... }
 *       used to resolve a website id from the domain when UMAMI_WEBSITE_ID is unset.
 *   - Metrics:   GET /api/websites/:websiteId/metrics?type=url&startAt=&endAt=
 *       returns [{ x: <url/path>, y: <count> }, ...] per page.
 *
 * Configuration comes from environment variables:
 *   UMAMI_BASE_URL      Base URL of the self-hosted Umami instance (required),
 *                       e.g. https://analytics.example.com  (with or without /api).
 *   UMAMI_WEBSITE_ID    The Umami website id to read (optional). When unset, the
 *                       provider looks it up from GET /api/websites by matching
 *                       the domain.
 *   UMAMI_API_KEY       A pre-issued bearer token (optional). When set, no login
 *                       call is made and this value is used as the Bearer token.
 *   UMAMI_USERNAME      Username for POST /api/auth/login (used when no API key).
 *   UMAMI_PASSWORD      Password for POST /api/auth/login (used when no API key).
 *   UMAMI_METRICS_TYPE  The metrics `type` to group pages by (optional). Defaults
 *                       to "url". Umami also supports "path"; some deployments
 *                       prefer "path" for clean per-page rows.
 *
 * Never throws on a config, network, or HTTP problem: returns
 * { pages: [], error: <message> } so the scoreboard degrades gracefully.
 */

import type {
   AnalyticsProvider, AnalyticsResult, NormalizedPage, ReferralResult, ReferralSource,
   SummaryResult, BreakdownResult, BreakdownRow, BreakdownDimension,
   TimeSeriesResult, TimeSeriesPoint, EventsResult, EventRow,
   EngagementResult, EngagementTier,
   EntryPagesResult, EntryPage, EntryPageSources,
} from './analytics';
import { cleanPath } from './lodd';
import { classifyReferrer, classifySourceClass, SourceClass } from './ai-sources';
import Domain from '../database/models/domain';

/**
 * Load the per-domain Umami website id stored on the Domain row, if any.
 *
 * This is the multi-tenant override: when a domain has been onboarded, its own
 * provisioned Umami website id lives on Domain.umami_website_id, and analytics
 * reads should target THAT website rather than the single UMAMI_WEBSITE_ID env.
 * Returns null when there is no row, no stored id, or the lookup fails (so the
 * env fallback still applies and getmasset.com is unchanged). Never throws.
 * @param {string} domain - Site domain, e.g. "getmasset.com".
 * @returns {Promise<string | null>} The stored website id, or null.
 */
const loadDomainWebsiteId = async (domain: string): Promise<string | null> => {
   try {
      const wanted = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
      if (!wanted) { return null; }
      const row = await Domain.findOne({ where: { domain: wanted } });
      const id = row?.umami_website_id ? String(row.umami_website_id).trim() : '';
      return id || null;
   } catch {
      return null;
   }
};

/** Strip a trailing slash and a trailing /api so we can build /api/... cleanly. */
export const normalizeBaseUrl = (raw: string): string => {
   let base = String(raw || '').trim().replace(/\/+$/, '');
   base = base.replace(/\/api$/i, '');
   return base;
};

/**
 * Resolve a usable bearer token for the Umami API.
 * Prefers a pre-issued UMAMI_API_KEY; otherwise logs in with username/password.
 * @param {string} base - Normalized base URL (no trailing slash, no /api).
 * @returns {Promise<{ token: string | null, error: string | null }>}
 */
export const getToken = async (base: string): Promise<{ token: string | null, error: string | null }> => {
   const apiKey = process.env.UMAMI_API_KEY;
   if (apiKey) { return { token: apiKey, error: null }; }

   const username = process.env.UMAMI_USERNAME;
   const password = process.env.UMAMI_PASSWORD;
   if (!username || !password) {
      return { token: null, error: 'Umami auth missing: set UMAMI_API_KEY or UMAMI_USERNAME + UMAMI_PASSWORD.' };
   }

   try {
      const res = await fetch(`${base}/api/auth/login`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { token: null, error: `Umami login failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      const token = json?.token ? String(json.token) : '';
      if (!token) { return { token: null, error: 'Umami login returned no token.' }; }
      return { token, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { token: null, error: `Umami login error: ${message}` };
   }
};

/**
 * Resolve the Umami website id for a domain.
 *
 * Resolution order (per-domain first, so multi-tenant domains each read their OWN
 * Umami website while getmasset.com keeps working unchanged):
 *   1. preferredId  - the Domain row's umami_website_id, when provisioned/stamped.
 *   2. UMAMI_WEBSITE_ID env - the legacy single-tenant fallback (getmasset.com).
 *   3. GET /api/websites lookup by matching domain - last resort.
 * @param {string} base - Normalized base URL.
 * @param {string} token - Bearer token.
 * @param {string} domain - Site domain, e.g. "getmasset.com".
 * @param {string | null} [preferredId] - A per-domain website id (Domain.umami_website_id).
 * @returns {Promise<{ websiteId: string | null, error: string | null }>}
 */
export const resolveWebsiteId = async (
   base: string,
   token: string,
   domain: string,
   preferredId?: string | null,
): Promise<{ websiteId: string | null, error: string | null }> => {
   const fromDomain = String(preferredId || '').trim();
   if (fromDomain) { return { websiteId: fromDomain, error: null }; }

   const fromEnv = process.env.UMAMI_WEBSITE_ID;
   if (fromEnv) { return { websiteId: fromEnv, error: null }; }

   try {
      const res = await fetch(`${base}/api/websites`, {
         headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { websiteId: null, error: `Umami websites lookup failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
      const wanted = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
      const match = rows.find((row) => {
         const d = String(row?.domain || '').trim().toLowerCase().replace(/^www\./, '');
         return d === wanted;
      });
      if (!match?.id) {
         return { websiteId: null, error: `No Umami website found for domain "${domain}". Set UMAMI_WEBSITE_ID.` };
      }
      return { websiteId: String(match.id), error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { websiteId: null, error: `Umami websites lookup error: ${message}` };
   }
};

/**
 * Translate a period string like "30d" / "7d" / "24h" into a [startAt, endAt]
 * pair of millisecond timestamps required by the Umami metrics endpoint.
 * Unrecognized input falls back to 30 days.
 * @param {string} period
 * @returns {{ startAt: number, endAt: number }}
 */
/**
 * Coerce an Umami stats field to a number. Umami serves stats fields either as
 * plain numbers (v3 self-hosted, as on our instance) or as { value, prev }
 * objects (some Cloud/version variants). This reads either shape.
 * @param {any} field
 * @returns {number}
 */
const statNum = (field: any): number => {
   if (field == null) { return 0; }
   if (typeof field === 'object') { return Number(field.value ?? 0); }
   return Number(field);
};

/**
 * Resolve the base URL, bearer token, and website id needed for any Umami call.
 * Returns an error string when configuration, auth, or website lookup fails so
 * callers can return their own empty-result shape without throwing.
 * @param {string} domain - Site domain, e.g. "getmasset.com".
 * @returns {Promise<{ base: string, token: string, websiteId: string } | { error: string }>}
 */
const resolveUmami = async (
   domain: string,
): Promise<{ base: string, token: string, websiteId: string } | { error: string }> => {
   const rawBase = process.env.UMAMI_BASE_URL;
   if (!rawBase) { return { error: 'Analytics provider umami is not configured' }; }
   const base = normalizeBaseUrl(rawBase);

   const { token, error: tokenError } = await getToken(base);
   if (!token) { return { error: tokenError || 'Umami auth failed.' }; }

   const preferredId = await loadDomainWebsiteId(domain);
   const { websiteId, error: idError } = await resolveWebsiteId(base, token, domain, preferredId);
   if (!websiteId) { return { error: idError || 'Umami website id not resolved.' }; }

   return { base, token, websiteId };
};

const periodToRange = (period: string): { startAt: number, endAt: number } => {
   const endAt = Date.now();
   const match = /^(\d+)\s*([dhwm])$/i.exec(String(period || '').trim());
   let days = 30;
   if (match) {
      const n = Number(match[1]);
      const unit = match[2].toLowerCase();
      if (unit === 'h') { days = n / 24; }
      else if (unit === 'd') { days = n; }
      else if (unit === 'w') { days = n * 7; }
      else if (unit === 'm') { days = n * 30; }
   }
   const startAt = endAt - Math.max(1, days) * 24 * 60 * 60 * 1000;
   return { startAt, endAt };
};

/**
 * Self-hosted Umami v2 implementation of the AnalyticsProvider interface.
 * Maps each metrics row (x = url/path, y = count) into a NormalizedPage with
 * page_views set.
 *
 * Per-page grain caveat: Umami's metrics endpoint groups by a single dimension
 * and returns one count per row (pageviews for type=path/url). It does not break
 * unique visitors, bounce rate, or average duration down per page. So per page:
 *   - page_views      is the real grouped count.
 *   - unique_visitors is left undefined (Umami does not expose it at page grain).
 *   - bounce_rate     is returned as null (known-unavailable at page grain).
 *   - avg_duration    is returned as null (known-unavailable at page grain).
 *   - metricsNote     explains the null so it is not read as zero.
 * Site-wide bounce rate and average duration ARE available and are surfaced by
 * getSummary; only the per-page split is unavailable from Umami's aggregate API.
 */
const UMAMI_PAGE_GRAIN_NOTE = 'Umami does not expose unique_visitors, bounce_rate, or avg_duration at '
   + 'page grain; bounce_rate and avg_duration are null (not zero). Use traffic_summary for site-wide '
   + 'bounce rate and average duration.';

/** Honest note for entry-page source attribution, surfaced whenever Umami is the provider. */
const UMAMI_ENTRY_SOURCE_NOTE = 'Per-entry-page source breakdown is APPROXIMATED from the site-wide '
   + 'referrer mix: Umami\'s metrics API reports referrers site-wide, not per landing page, so each page\'s '
   + 'direct/referral/search/ai split is its entry count scaled by the site-wide proportions, not measured '
   + 'per page. The site-wide totals (siteSources) and the per-page entry counts ARE exact.';

const EMPTY_ENTRY_SOURCES: EntryPageSources = { direct: 0, referral: 0, search: 0, ai: 0 };

/**
 * Bucket a list of Umami referrer rows ({ x: host/label, y: count }) into the four
 * first-touch source classes (direct/referral/search/ai), summing the counts. Pure;
 * never throws. Empty/blank referrers and self-referrals (matching selfHost) count
 * as direct via classifySourceClass.
 * @param {any[]} rows - Umami type=referrer metrics rows.
 * @param {string} selfHost - The site's own host, so self-referrals count as direct.
 * @returns {EntryPageSources}
 */
export const bucketReferrerRows = (rows: any[], selfHost: string): EntryPageSources => {
   const totals: EntryPageSources = { ...EMPTY_ENTRY_SOURCES };
   (Array.isArray(rows) ? rows : []).forEach((row) => {
      const name = String(row?.x ?? '');
      const count = Number(row?.y ?? 0);
      if (!Number.isFinite(count) || count <= 0) { return; }
      const klass: SourceClass = classifySourceClass(name, selfHost);
      totals[klass] += count;
   });
   return totals;
};

/**
 * Approximate a single entry page's source split from the site-wide source mix.
 * Each page's entry count is distributed across the four classes in the same
 * proportions the whole site shows. Rounds so the four buckets sum to `entries`
 * (the largest bucket absorbs the rounding remainder), so no entry is lost or
 * invented. When the site has no classified sources at all, everything falls to
 * direct (the honest default for "no referrer signal"). Pure; never throws.
 * @param {number} entries - This page's entry count.
 * @param {EntryPageSources} site - The site-wide source totals.
 * @returns {EntryPageSources}
 */
export const approximatePageSources = (entries: number, site: EntryPageSources): EntryPageSources => {
   const n = Math.max(0, Math.round(Number(entries) || 0));
   if (n === 0) { return { ...EMPTY_ENTRY_SOURCES }; }
   const siteTotal = site.direct + site.referral + site.search + site.ai;
   if (siteTotal <= 0) { return { direct: n, referral: 0, search: 0, ai: 0 }; }

   const order: (keyof EntryPageSources)[] = ['direct', 'referral', 'search', 'ai'];
   const out: EntryPageSources = { ...EMPTY_ENTRY_SOURCES };
   let assigned = 0;
   order.forEach((key) => {
      const share = Math.floor((site[key] / siteTotal) * n);
      out[key] = share;
      assigned += share;
   });
   // Hand the rounding remainder to the largest site bucket so the four sum to n exactly.
   let remainder = n - assigned;
   if (remainder > 0) {
      const biggest = order.reduce((a, b) => (site[b] > site[a] ? b : a), order[0]);
      out[biggest] += remainder;
   }
   return out;
};

export class UmamiProvider implements AnalyticsProvider {
   // eslint-disable-next-line class-methods-use-this
   async getPageTraffic(domain: string, period = '30d'): Promise<AnalyticsResult> {
      const rawBase = process.env.UMAMI_BASE_URL;
      if (!rawBase) {
         return { pages: [], error: 'Analytics provider umami is not configured' };
      }
      const base = normalizeBaseUrl(rawBase);

      const { token, error: tokenError } = await getToken(base);
      if (!token) { return { pages: [], error: tokenError }; }

      const preferredId = await loadDomainWebsiteId(domain);
      const { websiteId, error: idError } = await resolveWebsiteId(base, token, domain, preferredId);
      if (!websiteId) { return { pages: [], error: idError }; }

      // Umami v3 groups per-page metrics under type "path" (v2 used "url").
      const metricsType = (process.env.UMAMI_METRICS_TYPE || 'path').trim();
      const { startAt, endAt } = periodToRange(period);
      const params = new URLSearchParams({
         type: metricsType,
         startAt: String(startAt),
         endAt: String(endAt),
         limit: '500',
      });
      const url = `${base}/api/websites/${websiteId}/metrics?${params.toString()}`;

      try {
         const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { pages: [], error: `Umami metrics request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         const rows: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
         const pages: NormalizedPage[] = rows.map((row) => {
            const rawUrl = String(row?.x ?? '');
            // Umami v3 metrics rows can carry a visitors count alongside the
            // grouped pageview count (`y`) under `visitors` on some deployments.
            // Honor it when present; otherwise leave unique_visitors undefined
            // rather than copying pageviews into it.
            const visitorsRaw = row?.visitors ?? row?.v;
            const uniqueVisitors = visitorsRaw == null ? undefined : Number(visitorsRaw);
            return {
               url: rawUrl,
               pathClean: cleanPath(rawUrl),
               page_views: Number(row?.y ?? 0),
               unique_visitors: uniqueVisitors,
               // Known-unavailable at page grain: null (not zero), with a note.
               bounce_rate: null,
               avg_duration: null,
               metricsNote: UMAMI_PAGE_GRAIN_NOTE,
            };
         });
         return { pages, error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { pages: [], error: `Umami metrics request error: ${message}` };
      }
   }

   // eslint-disable-next-line class-methods-use-this
   async getReferralSources(domain: string, period = '90d'): Promise<ReferralResult> {
      const rawBase = process.env.UMAMI_BASE_URL;
      if (!rawBase) {
         return { sources: [], error: 'Analytics provider umami is not configured' };
      }
      const base = normalizeBaseUrl(rawBase);

      const { token, error: tokenError } = await getToken(base);
      if (!token) { return { sources: [], error: tokenError }; }

      const preferredId = await loadDomainWebsiteId(domain);
      const { websiteId, error: idError } = await resolveWebsiteId(base, token, domain, preferredId);
      if (!websiteId) { return { sources: [], error: idError }; }

      // Umami reports referrers via the metrics endpoint with type=referrer.
      // Each row is { x: <referrer host/url>, y: <count> }. Umami does NOT tag
      // AI; classification is done entirely by the classifier.
      const { startAt, endAt } = periodToRange(period);
      const params = new URLSearchParams({
         type: 'referrer',
         startAt: String(startAt),
         endAt: String(endAt),
         limit: '500',
      });
      const url = `${base}/api/websites/${websiteId}/metrics?${params.toString()}`;

      try {
         const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { sources: [], error: `Umami referrer metrics request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         const rows: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
         const sources: ReferralSource[] = rows.map((row) => {
            const name = String(row?.x ?? '');
            const classified = classifyReferrer(name);
            return {
               name,
               type: classified.isAI ? 'ai' : 'referral',
               engine: classified.engine,
               isAI: classified.isAI,
               unique_visitors: Number(row?.y ?? 0),
            };
         });
         return { sources, error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { sources: [], error: `Umami referrer metrics request error: ${message}` };
      }
   }

   // eslint-disable-next-line class-methods-use-this
   async getSummary(domain: string, period = '30d'): Promise<SummaryResult> {
      const empty: SummaryResult = {
         pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: null,
      };
      const r = await resolveUmami(domain);
      if ('error' in r) { return { ...empty, error: r.error }; }

      const { startAt, endAt } = periodToRange(period);
      const params = new URLSearchParams({ startAt: String(startAt), endAt: String(endAt) });
      const url = `${r.base}/api/websites/${r.websiteId}/stats?${params.toString()}`;
      try {
         const res = await fetch(url, { headers: { Authorization: `Bearer ${r.token}` } });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ...empty, error: `Umami stats request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         const pageviews = statNum(json?.pageviews);
         const visitors = statNum(json?.visitors);
         const visits = statNum(json?.visits);
         const bounces = statNum(json?.bounces);
         const totaltime = statNum(json?.totaltime);
         // Derive Lodd-parity totals. visits is the denominator for engagement
         // metrics; guard against divide-by-zero. avgDuration and totaltime are
         // in seconds on Umami v3. bounceRate is expressed as a 0..100 percentage.
         const bounceRate = visits > 0 ? (bounces / visits) * 100 : 0;
         const avgDuration = visits > 0 ? totaltime / visits : 0;
         const pagesPerVisit = visits > 0 ? pageviews / visits : 0;
         return { pageviews, visitors, visits, bounceRate, avgDuration, pagesPerVisit, error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { ...empty, error: `Umami stats request error: ${message}` };
      }
   }

   // eslint-disable-next-line class-methods-use-this
   async getBreakdown(domain: string, dimension: BreakdownDimension, period = '30d'): Promise<BreakdownResult> {
      const r = await resolveUmami(domain);
      if ('error' in r) { return { rows: [], error: r.error }; }

      // Umami metrics type is the dimension name directly (country, region, city,
      // device, browser, os, language, screen). Each row is { x: <name>, y: <count> }.
      // Umami url-style metrics report a single count per row; we surface it as
      // unique_visitors (the count Umami groups by for these dimensions).
      const { startAt, endAt } = periodToRange(period);
      const params = new URLSearchParams({
         type: dimension,
         startAt: String(startAt),
         endAt: String(endAt),
         limit: '500',
      });
      const url = `${r.base}/api/websites/${r.websiteId}/metrics?${params.toString()}`;
      try {
         const res = await fetch(url, { headers: { Authorization: `Bearer ${r.token}` } });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { rows: [], error: `Umami ${dimension} metrics request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         const data: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
         const rows: BreakdownRow[] = data.map((row) => ({
            name: String(row?.x ?? ''),
            unique_visitors: Number(row?.y ?? 0),
         }));
         return { rows, error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { rows: [], error: `Umami ${dimension} metrics request error: ${message}` };
      }
   }

   // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
   async getTimeSeries(domain: string, period = '30d', unit = 'day'): Promise<TimeSeriesResult> {
      const r = await resolveUmami(domain);
      if ('error' in r) { return { series: [], error: r.error }; }

      // Umami /pageviews returns { pageviews: [{x,y}], sessions: [{x,y}] } where
      // x is a datetime bucket and y the count. We treat sessions as the visitors
      // series and align the two arrays by their bucket label (x).
      const { startAt, endAt } = periodToRange(period);
      const params = new URLSearchParams({
         startAt: String(startAt),
         endAt: String(endAt),
         unit,
         timezone: 'UTC',
      });
      const url = `${r.base}/api/websites/${r.websiteId}/pageviews?${params.toString()}`;
      try {
         const res = await fetch(url, { headers: { Authorization: `Bearer ${r.token}` } });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { series: [], error: `Umami pageviews request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         const pv: any[] = Array.isArray(json?.pageviews) ? json.pageviews : [];
         const ss: any[] = Array.isArray(json?.sessions) ? json.sessions : [];
         const visitorsByDate = new Map<string, number>();
         ss.forEach((row) => { visitorsByDate.set(String(row?.x ?? ''), Number(row?.y ?? 0)); });
         const series: TimeSeriesPoint[] = pv.map((row) => {
            const date = String(row?.x ?? '');
            return {
               date,
               pageviews: Number(row?.y ?? 0),
               visitors: visitorsByDate.get(date) ?? 0,
            };
         });
         return { series, error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { series: [], error: `Umami pageviews request error: ${message}` };
      }
   }

   // eslint-disable-next-line class-methods-use-this
   async getEvents(domain: string, period = '30d'): Promise<EventsResult> {
      const r = await resolveUmami(domain);
      if ('error' in r) { return { events: [], error: r.error }; }

      // Umami reports custom events via metrics type=event: { x: <event name>, y: <count> }.
      const { startAt, endAt } = periodToRange(period);
      const params = new URLSearchParams({
         type: 'event',
         startAt: String(startAt),
         endAt: String(endAt),
         limit: '500',
      });
      const url = `${r.base}/api/websites/${r.websiteId}/metrics?${params.toString()}`;
      try {
         const res = await fetch(url, { headers: { Authorization: `Bearer ${r.token}` } });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { events: [], error: `Umami event metrics request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         const data: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
         const events: EventRow[] = data.map((row) => ({
            name: String(row?.x ?? ''),
            count: Number(row?.y ?? 0),
         }));
         return { events, error: null };
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { events: [], error: `Umami event metrics request error: ${message}` };
      }
   }

   async getEngagement(domain: string, period = '30d'): Promise<EngagementResult> {
      // Umami has no native session-score buckets, so we DERIVE engagement tiers
      // from the same totals getSummary surfaces (Umami /stats). The derivation
      // splits all sessions into two evidence-based tiers that mirror Lodd's
      // session-scores shape:
      //   bounced  = single-page, near-zero-engagement sessions (Umami `bounces`).
      //   browsed  = the remaining (non-bounced) sessions, i.e. visits - bounces,
      //              with avgPages = pagesPerVisit and avgDuration = avgDuration
      //              from the window totals.
      // This is intentionally coarse: Umami's aggregate /stats does not expose a
      // per-session score distribution, so finer tiers (e.g. "engaged" vs
      // "converted") would require per-session aggregation over /sessions, which
      // is out of scope here. The two-tier split is the honest, derivable bucket.
      const summary = await this.getSummary(domain, period);
      if (summary.error) { return { tiers: [], error: summary.error }; }

      const visits = summary.visits ?? 0;
      if (visits <= 0) { return { tiers: [], error: null }; }

      // visits - browsed; bounces are not exposed on SummaryResult directly, so
      // recompute the bounced count from the rate we derived in getSummary.
      const bounced = Math.round((summary.bounceRate / 100) * visits);
      const browsed = Math.max(0, visits - bounced);
      const pct = (n: number): number => (visits > 0 ? (n / visits) * 100 : 0);

      const tiers: EngagementTier[] = [
         {
            label: 'bounced',
            sessions: bounced,
            percentage: pct(bounced),
            avgDuration: 0,
            avgPages: 1,
         },
         {
            label: 'browsed',
            sessions: browsed,
            percentage: pct(browsed),
            avgDuration: summary.avgDuration,
            avgPages: summary.pagesPerVisit,
         },
      ];
      return { tiers, error: null };
   }

   /**
    * Return ENTRY (landing) pages for a domain: where sessions START, the
    * acquisition surface. Each page gets its entry count plus a first-touch
    * source split (direct/referral/search/ai).
    *
    * Two Umami calls, both on the metrics endpoint:
    *   - type=entry    -> [{ x: <entry page url/path>, y: <session count> }]
    *                      the exact per-page entry counts.
    *   - type=referrer -> [{ x: <referrer host/label>, y: <count> }]
    *                      site-wide referrers, bucketed into the four classes by
    *                      the shared classifier (classifySourceClass).
    *
    * HONEST DATA STORY: Umami does NOT break referrers down per entry page, so a
    * page's source split is APPROXIMATED by scaling the page's entry count by the
    * site-wide source proportions. The per-page entry counts and the site-wide
    * source totals are exact; only the per-page split is estimated. Every page is
    * flagged sourcesApproximated:true and the result carries sourcesNote so the
    * estimate is never mistaken for measured per-page attribution. This mirrors
    * how ai_visibility is honest when first-party data is thin.
    *
    * Degrades gracefully: a referrer failure does NOT fail the whole call. Entry
    * pages still come back with zeroed (all-direct-by-default) sources and the
    * referrer error is surfaced. Never throws.
    * @param {string} domain - Site domain, e.g. "getmasset.com".
    * @param {string} [period] - Reporting window, e.g. "30d". Defaults to "30d".
    * @returns {Promise<EntryPagesResult>} Never rejects; errors come back in `error`.
    */
   // eslint-disable-next-line class-methods-use-this
   async getEntryPages(domain: string, period = '30d'): Promise<EntryPagesResult> {
      const empty: EntryPagesResult = {
         pages: [], siteSources: { ...EMPTY_ENTRY_SOURCES }, sourcesNote: null, error: null,
      };
      const r = await resolveUmami(domain);
      if ('error' in r) { return { ...empty, error: r.error }; }

      const { startAt, endAt } = periodToRange(period);
      const metricsUrl = (type: string): string => {
         const params = new URLSearchParams({
            type, startAt: String(startAt), endAt: String(endAt), limit: '500',
         });
         return `${r.base}/api/websites/${r.websiteId}/metrics?${params.toString()}`;
      };
      const headers = { Authorization: `Bearer ${r.token}` };

      // 1. Entry pages (exact per-page entry counts). A failure here IS fatal to the
      // call, since with no entry pages there is nothing to attribute sources to.
      let entryRows: any[] = [];
      try {
         const res = await fetch(metricsUrl('entry'), { headers });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            return { ...empty, error: `Umami entry metrics request failed (${res.status}): ${text || res.statusText}` };
         }
         const json: any = await res.json();
         entryRows = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
      } catch (error) {
         const message = error instanceof Error ? error.message : String(error);
         return { ...empty, error: `Umami entry metrics request error: ${message}` };
      }

      // 2. Site-wide referrers -> the four source classes. A failure here is NON-fatal:
      // entry pages still come back, sources default to all-direct, and the referrer
      // error is surfaced (graceful degradation, never a 500 from a sub-signal).
      const selfHost = String(domain || '').trim().toLowerCase().replace(/^www\./, '');
      let siteSources: EntryPageSources = { ...EMPTY_ENTRY_SOURCES };
      let referrerError: string | null = null;
      try {
         const res = await fetch(metricsUrl('referrer'), { headers });
         if (!res.ok) {
            const text = await res.text().catch(() => '');
            referrerError = `Umami referrer metrics request failed (${res.status}): ${text || res.statusText}`;
         } else {
            const json: any = await res.json();
            const rows: any[] = Array.isArray(json) ? json : (Array.isArray(json?.data) ? json.data : []);
            siteSources = bucketReferrerRows(rows, selfHost);
         }
      } catch (error) {
         referrerError = `Umami referrer metrics request error: ${error instanceof Error ? error.message : String(error)}`;
      }

      const pages: EntryPage[] = entryRows.map((row) => {
         const rawUrl = String(row?.x ?? '');
         const entries = Number(row?.y ?? 0);
         return {
            page: rawUrl,
            pathClean: cleanPath(rawUrl),
            entries,
            sources: approximatePageSources(entries, siteSources),
            sourcesApproximated: true,
         };
      });
      pages.sort((a, b) => b.entries - a.entries);

      return { pages, siteSources, sourcesNote: UMAMI_ENTRY_SOURCE_NOTE, error: referrerError };
   }
}

export default UmamiProvider;
