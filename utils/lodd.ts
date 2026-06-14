/**
 * Lodd Analytics integration.
 *
 * Reads per-page traffic for a site from the Lodd Analytics API and normalizes
 * it for joining against s33k keywords by page path.
 *
 * Lodd is a closed third-party SaaS. It is kept as a legacy/dev analytics
 * provider; the standalone, owned analytics engine is self-hosted Umami
 * (see utils/umami.ts). Provider selection lives in utils/analytics.ts.
 *
 * Configuration comes from environment variables:
 *   LODD_API_KEY      Bearer token for the Lodd API (required)
 *   LODD_SITE         The Lodd site UUID to read traffic for (required)
 *   LODD_BASE_URL     Base URL of the Lodd API (optional, defaults to https://api.lodd.dev/v1)
 *   LODD_SITE_DOMAIN  The domain that LODD_SITE belongs to (optional). When set,
 *                     it is used to scope per-domain calls without an API lookup.
 *                     When unset, the domain is resolved once from GET /sites and
 *                     cached. See "domain scoping" below.
 *
 * Domain scoping (single-site honesty):
 *   Lodd is keyed by a single LODD_SITE UUID, not by domain. A naive provider
 *   would return that one site's data for ANY requested domain, silently
 *   mislabeling (for example) competitor.com traffic as getmasset.com data.
 *   To stay honest, every method first checks the requested domain against the
 *   configured site's domain. On a mismatch it returns an empty, non-crashing
 *   result with a clear explanatory error instead of the wrong site's numbers.
 */

import type {
   AnalyticsProvider, AnalyticsResult, NormalizedPage, ReferralResult, ReferralSource,
   SummaryResult, BreakdownResult, BreakdownRow, BreakdownDimension,
   TimeSeriesResult, TimeSeriesPoint, EventsResult, EventRow,
   EngagementResult, EngagementTier,
} from './analytics';
import { classifyReferrer } from './ai-sources';

export type LoddPage = {
   url: string,
   pathClean: string,
   page_title: string,
   page_views: number,
   unique_visitors: number,
   bounce_rate: number,
   avg_duration: number,
}

export type LoddResult = {
   pages: LoddPage[],
   error: string | null,
}

/**
 * Normalize a url/path to a clean comparable path.
 * Lowercases, strips any query string, and removes a trailing slash.
 * The root path "/" is preserved as "/".
 * @param {string} input - A url or path, e.g. "/Compare/Masset-vs-Seismic/?ref=x".
 * @returns {string} The cleaned path, e.g. "/compare/masset-vs-seismic".
 */
export const cleanPath = (input: string): string => {
   if (!input) { return ''; }
   let path = String(input).trim();
   // Drop the origin if a full URL was passed; keep only the path.
   try {
      if (/^https?:\/\//i.test(path)) {
         path = new URL(path).pathname;
      }
   } catch {
      // Not a parseable URL, fall through and treat as a path.
   }
   path = path.toLowerCase();
   // Remove any query string or fragment.
   path = path.split('?')[0].split('#')[0];
   // Remove a trailing slash, but keep the root "/".
   if (path.length > 1 && path.endsWith('/')) {
      path = path.replace(/\/+$/, '');
   }
   if (path === '') { path = '/'; }
   return path;
};

/**
 * Fetch per-page traffic from Lodd for the configured site.
 * Never throws on a network or config problem: returns an empty page list and a
 * clear error string instead so callers can degrade gracefully.
 * @param {string} period - The reporting window, e.g. "30d". Defaults to "30d".
 * @param {number} limit - Max pages to request. Defaults to 200.
 * @returns {Promise<LoddResult>}
 */
const getLoddPages = async (period = '30d', limit = 200): Promise<LoddResult> => {
   const apiKey = process.env.LODD_API_KEY;
   const site = process.env.LODD_SITE;
   const baseUrl = (process.env.LODD_BASE_URL || 'https://api.lodd.dev/v1').replace(/\/$/, '');

   if (!apiKey || !site) {
      const missing = [!apiKey ? 'LODD_API_KEY' : '', !site ? 'LODD_SITE' : ''].filter(Boolean).join(', ');
      return { pages: [], error: `Lodd analytics not configured. Missing env: ${missing}.` };
   }

   const url = `${baseUrl}/sites/${site}/pages?period=${encodeURIComponent(period)}&limit=${limit}`;

   try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { pages: [], error: `Lodd API request failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json?.data) ? json.data : [];
      const pages: LoddPage[] = rows.map((row) => {
         const rawUrl = String(row?.url ?? '');
         return {
            url: rawUrl,
            pathClean: cleanPath(rawUrl),
            page_title: String(row?.page_title ?? ''),
            page_views: Number(row?.page_views ?? 0),
            unique_visitors: Number(row?.unique_visitors ?? 0),
            bounce_rate: Number(row?.bounce_rate ?? 0),
            avg_duration: Number(row?.avg_duration ?? 0),
         };
      });
      return { pages, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { pages: [], error: `Lodd API request error: ${message}` };
   }
};

/**
 * Fetch referral sources from Lodd for the configured site.
 * Lodd already tags AI referrers with source_type === "ai" and puts the engine
 * name in source_name. We honor that, and also run the classifier to normalize
 * the engine label and to catch any AI source Lodd did not tag.
 * Never throws: returns an empty list and a clear error string on failure.
 * @param {string} period - Reporting window, e.g. "90d". Defaults to "90d".
 * @param {number} limit - Max sources to request. Defaults to 200.
 * @returns {Promise<ReferralResult>}
 */
const getLoddReferrals = async (period = '90d', limit = 200): Promise<ReferralResult> => {
   const apiKey = process.env.LODD_API_KEY;
   const site = process.env.LODD_SITE;
   const baseUrl = (process.env.LODD_BASE_URL || 'https://api.lodd.dev/v1').replace(/\/$/, '');

   if (!apiKey || !site) {
      const missing = [!apiKey ? 'LODD_API_KEY' : '', !site ? 'LODD_SITE' : ''].filter(Boolean).join(', ');
      return { sources: [], error: `Lodd analytics not configured. Missing env: ${missing}.` };
   }

   const url = `${baseUrl}/sites/${site}/sources?period=${encodeURIComponent(period)}&limit=${limit}`;

   try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { sources: [], error: `Lodd API request failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json?.data) ? json.data : [];
      const sources: ReferralSource[] = rows.map((row) => {
         const name = String(row?.source_name ?? '');
         const sourceType = String(row?.source_type ?? '').toLowerCase();
         // Classify against the source name (Lodd labels AI engines there).
         const classified = classifyReferrer(name);
         const taggedAI = sourceType === 'ai';
         const isAI = taggedAI || classified.isAI;
         return {
            name,
            type: sourceType || 'unknown',
            engine: classified.engine,
            isAI,
            page_views: Number(row?.page_views ?? 0),
            unique_visitors: Number(row?.unique_visitors ?? 0),
            utm_source: row?.utm_source ? String(row.utm_source) : undefined,
            utm_medium: row?.utm_medium ? String(row.utm_medium) : undefined,
            utm_campaign: row?.utm_campaign ? String(row.utm_campaign) : undefined,
         };
      });
      return { sources, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { sources: [], error: `Lodd API request error: ${message}` };
   }
};

/** Resolve Lodd config (api key, site, base url) from the environment. */
const loddConfig = (): { apiKey?: string, site?: string, baseUrl: string } => ({
   apiKey: process.env.LODD_API_KEY,
   site: process.env.LODD_SITE,
   baseUrl: (process.env.LODD_BASE_URL || 'https://api.lodd.dev/v1').replace(/\/$/, ''),
});

/**
 * Normalize a domain for comparison: lowercase, trimmed, scheme/path stripped,
 * leading "www." removed.
 * @param {string} input - A domain or URL.
 * @returns {string} A bare, comparable hostname, e.g. "getmasset.com".
 */
const normalizeDomainForMatch = (input: string): string => String(input || '')
   .trim()
   .toLowerCase()
   .replace(/^https?:\/\//, '')
   .replace(/^www\./, '')
   .replace(/\/.*$/, '');

/**
 * Cache of the configured LODD_SITE's domain, resolved once from GET /sites and
 * reused for the process lifetime. `null` means "not resolved yet"; a resolved
 * value of `''` means "the API returned a site but with no domain".
 */
let cachedSiteDomain: string | null = null;
let cachedSiteDomainKey = '';

/**
 * Resolve the domain that the configured LODD_SITE belongs to.
 * Order of resolution:
 *   1. LODD_SITE_DOMAIN env var, if set (no API call).
 *   2. A cached value from a prior GET /sites lookup.
 *   3. A fresh GET /sites lookup, matching the row whose id === LODD_SITE.
 * Never throws: on any failure it returns { domain: null, error }.
 * @returns {Promise<{ domain: string | null, error: string | null }>}
 */
const resolveLoddSiteDomain = async (): Promise<{ domain: string | null, error: string | null }> => {
   const { apiKey, site, baseUrl } = loddConfig();
   if (!apiKey || !site) {
      const missing = [!apiKey ? 'LODD_API_KEY' : '', !site ? 'LODD_SITE' : ''].filter(Boolean).join(', ');
      return { domain: null, error: `Lodd analytics not configured. Missing env: ${missing}.` };
   }

   const fromEnv = process.env.LODD_SITE_DOMAIN;
   if (fromEnv) { return { domain: normalizeDomainForMatch(fromEnv), error: null }; }

   // Invalidate the cache if the configured site changed (e.g. in tests).
   if (cachedSiteDomain !== null && cachedSiteDomainKey === site) {
      return { domain: cachedSiteDomain, error: null };
   }

   try {
      const res = await fetch(`${baseUrl}/sites`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { domain: null, error: `Lodd sites lookup failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      const rows: any[] = Array.isArray(json?.data) ? json.data : (Array.isArray(json) ? json : []);
      const match = rows.find((row) => String(row?.id ?? '') === site);
      if (!match) {
         return { domain: null, error: `Lodd site ${site} not found in this account's site list.` };
      }
      const domain = normalizeDomainForMatch(String(match?.domain ?? ''));
      cachedSiteDomain = domain;
      cachedSiteDomainKey = site;
      return { domain, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { domain: null, error: `Lodd sites lookup error: ${message}` };
   }
};

/**
 * Guard a per-domain Lodd request against the single configured site.
 * Returns { ok: true } when the requested domain matches the configured site's
 * domain (or when the configured site's domain cannot be determined, in which
 * case we fail open rather than block the only configured site). Returns
 * { ok: false, error } with a clear message when the requested domain provably
 * does not match the configured site, so callers can return an empty result
 * instead of the wrong site's data.
 * @param {string} requestedDomain - The domain the caller asked about.
 * @returns {Promise<{ ok: boolean, error: string | null, siteDomain: string | null }>}
 */
const ensureDomainMatchesSite = async (
   requestedDomain: string,
): Promise<{ ok: boolean, error: string | null, siteDomain: string | null }> => {
   const { domain: siteDomain, error } = await resolveLoddSiteDomain();
   // If we genuinely cannot determine the site's domain, do not block: Lodd is
   // configured for exactly one site, so serving it is the least-wrong behavior.
   // The lookup error is surfaced so the caller can still report it.
   if (!siteDomain) { return { ok: true, error, siteDomain: null }; }

   const wanted = normalizeDomainForMatch(requestedDomain);
   if (!wanted) { return { ok: true, error: null, siteDomain }; }
   if (wanted === siteDomain) { return { ok: true, error: null, siteDomain }; }

   return {
      ok: false,
      siteDomain,
      error: `Lodd is configured for a single site ("${siteDomain}") and cannot report on "${wanted}". `
         + 'Lodd is keyed by LODD_SITE, not by domain, so it can only serve its one configured site. '
         + 'Point LODD_SITE at this domain, set LODD_SITE_DOMAIN, or use the Umami provider for multi-domain analytics.',
   };
};

/**
 * GET a Lodd endpoint and return its `data` payload (the array or object Lodd
 * wraps under `data`). Never throws: on a config, network, or HTTP problem it
 * returns { data: null, error: <message> }.
 * @param {string} path - The path after /sites/{site}, e.g. "/analytics" or "/countries".
 * @param {Record<string, string | number>} [query] - Query params (period, limit, ...).
 * @returns {Promise<{ data: any, error: string | null }>}
 */
const loddGet = async (
   path: string,
   query: Record<string, string | number> = {},
): Promise<{ data: any, error: string | null }> => {
   const { apiKey, site, baseUrl } = loddConfig();
   if (!apiKey || !site) {
      const missing = [!apiKey ? 'LODD_API_KEY' : '', !site ? 'LODD_SITE' : ''].filter(Boolean).join(', ');
      return { data: null, error: `Lodd analytics not configured. Missing env: ${missing}.` };
   }
   const params = new URLSearchParams();
   Object.entries(query).forEach(([k, v]) => params.set(k, String(v)));
   const qs = params.toString();
   const url = `${baseUrl}/sites/${site}${path}${qs ? `?${qs}` : ''}`;
   try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) {
         const text = await res.text().catch(() => '');
         return { data: null, error: `Lodd API request failed (${res.status}): ${text || res.statusText}` };
      }
      const json: any = await res.json();
      return { data: json?.data ?? null, error: null };
   } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { data: null, error: `Lodd API request error: ${message}` };
   }
};

/**
 * Fetch site-wide totals from Lodd /analytics and map them to SummaryResult.
 * @param {string} period - Reporting window, e.g. "30d". Defaults to "30d".
 * @returns {Promise<SummaryResult>}
 */
const getLoddSummary = async (period = '30d'): Promise<SummaryResult> => {
   const { data, error } = await loddGet('/analytics', { period });
   if (error || !data) {
      return {
         pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0,
         error: error || 'Lodd analytics returned no data.',
      };
   }
   return {
      pageviews: Number(data.total_page_views ?? 0),
      visitors: Number(data.unique_visitors ?? 0),
      bounceRate: Number(data.bounce_rate ?? 0),
      avgDuration: Number(data.average_duration ?? 0),
      pagesPerVisit: Number(data.pages_per_visit ?? 0),
      error: null,
   };
};

/**
 * Map a Lodd breakdown dimension to its endpoint and the field holding the
 * dimension name. region/city/language/screen have no Lodd endpoint.
 */
const LODD_BREAKDOWN: Partial<Record<BreakdownDimension, { path: string, nameField: string }>> = {
   country: { path: '/countries', nameField: 'country' },
   device: { path: '/devices', nameField: 'device_type' },
   browser: { path: '/browsers', nameField: 'browser' },
   os: { path: '/operating-systems', nameField: 'os' },
};

/**
 * Fetch a dimensional breakdown from Lodd. For dimensions Lodd does not support
 * (region, city, language, screen) returns { rows: [], error: 'Not supported by Lodd' }.
 * @param {BreakdownDimension} dimension
 * @param {string} period - Reporting window, e.g. "30d". Defaults to "30d".
 * @param {number} limit - Max rows. Defaults to 200.
 * @returns {Promise<BreakdownResult>}
 */
const getLoddBreakdown = async (
   dimension: BreakdownDimension,
   period = '30d',
   limit = 200,
): Promise<BreakdownResult> => {
   const map = LODD_BREAKDOWN[dimension];
   if (!map) { return { rows: [], error: 'Not supported by Lodd' }; }
   const { data, error } = await loddGet(map.path, { period, limit });
   if (error) { return { rows: [], error }; }
   const rows: BreakdownRow[] = (Array.isArray(data) ? data : []).map((row: any) => ({
      name: String(row?.[map.nameField] ?? ''),
      page_views: Number(row?.page_views ?? 0),
      unique_visitors: Number(row?.unique_visitors ?? 0),
   }));
   return { rows, error: null };
};

/**
 * Fetch a daily time series from Lodd /timeseries. Lodd rows are
 * { date_label, page_views, unique_visitors }.
 * @param {string} period - Reporting window, e.g. "30d". Defaults to "30d".
 * @param {string} unit - Bucket unit hint passed to Lodd. Defaults to "day".
 * @returns {Promise<TimeSeriesResult>}
 */
const getLoddTimeSeries = async (period = '30d', unit = 'day'): Promise<TimeSeriesResult> => {
   const { data, error } = await loddGet('/timeseries', { period, unit });
   if (error) { return { series: [], error }; }
   const series: TimeSeriesPoint[] = (Array.isArray(data) ? data : []).map((row: any) => ({
      date: String(row?.date_label ?? ''),
      pageviews: Number(row?.page_views ?? 0),
      visitors: Number(row?.unique_visitors ?? 0),
   }));
   return { series, error: null };
};

/**
 * Fetch custom events from Lodd /events. Lodd's events array is currently empty
 * but the shape is honored when present (name + count fields).
 * @param {string} period - Reporting window, e.g. "30d". Defaults to "30d".
 * @returns {Promise<EventsResult>}
 */
const getLoddEvents = async (period = '30d'): Promise<EventsResult> => {
   const { data, error } = await loddGet('/events', { period });
   if (error) { return { events: [], error }; }
   const events: EventRow[] = (Array.isArray(data) ? data : []).map((row: any) => ({
      name: String(row?.event_name ?? row?.name ?? row?.event ?? ''),
      count: Number(row?.count ?? row?.event_count ?? row?.page_views ?? 0),
   }));
   return { events, error: null };
};

/**
 * Fetch engagement tiers from Lodd /session-scores. Lodd rows are
 * { score_label, session_count, percentage, avg_duration, avg_pages }.
 * @param {string} period - Reporting window, e.g. "30d". Defaults to "30d".
 * @returns {Promise<EngagementResult>}
 */
const getLoddEngagement = async (period = '30d'): Promise<EngagementResult> => {
   const { data, error } = await loddGet('/session-scores', { period });
   if (error) { return { tiers: [], error }; }
   const tiers: EngagementTier[] = (Array.isArray(data) ? data : []).map((row: any) => ({
      label: String(row?.score_label ?? ''),
      sessions: Number(row?.session_count ?? 0),
      percentage: Number(row?.percentage ?? 0),
      avgDuration: row?.avg_duration == null ? undefined : Number(row.avg_duration),
      avgPages: row?.avg_pages == null ? undefined : Number(row.avg_pages),
   }));
   return { tiers, error: null };
};

/**
 * Lodd implementation of the AnalyticsProvider interface.
 *
 * Lodd is keyed by a single LODD_SITE UUID, not by domain. Every method first
 * checks the requested domain against the configured site's domain (see
 * ensureDomainMatchesSite). On a provable mismatch it returns an empty,
 * non-crashing result with a clear explanatory error rather than the wrong
 * site's data. A matched (or undeterminable) domain passes through to the
 * underlying single-site fetchers. A LoddPage already satisfies NormalizedPage
 * (its extra fields are the optional ones), so the page list passes through.
 */
export class LoddProvider implements AnalyticsProvider {
   // eslint-disable-next-line class-methods-use-this
   async getPageTraffic(domain: string, period = '30d'): Promise<AnalyticsResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) { return { pages: [], error: guard.error }; }
      const { pages, error } = await getLoddPages(period);
      return { pages: pages as NormalizedPage[], error };
   }

   // eslint-disable-next-line class-methods-use-this
   async getReferralSources(domain: string, period = '90d'): Promise<ReferralResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) { return { sources: [], error: guard.error }; }
      return getLoddReferrals(period);
   }

   // eslint-disable-next-line class-methods-use-this
   async getSummary(domain: string, period = '30d'): Promise<SummaryResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) {
         return {
            pageviews: 0, visitors: 0, bounceRate: 0, avgDuration: 0, pagesPerVisit: 0, error: guard.error,
         };
      }
      return getLoddSummary(period);
   }

   // eslint-disable-next-line class-methods-use-this
   async getBreakdown(domain: string, dimension: BreakdownDimension, period = '30d'): Promise<BreakdownResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) { return { rows: [], error: guard.error }; }
      return getLoddBreakdown(dimension, period);
   }

   // eslint-disable-next-line class-methods-use-this
   async getTimeSeries(domain: string, period = '30d', unit = 'day'): Promise<TimeSeriesResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) { return { series: [], error: guard.error }; }
      return getLoddTimeSeries(period, unit);
   }

   // eslint-disable-next-line class-methods-use-this
   async getEvents(domain: string, period = '30d'): Promise<EventsResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) { return { events: [], error: guard.error }; }
      return getLoddEvents(period);
   }

   // eslint-disable-next-line class-methods-use-this
   async getEngagement(domain: string, period = '30d'): Promise<EngagementResult> {
      const guard = await ensureDomainMatchesSite(domain);
      if (!guard.ok) { return { tiers: [], error: guard.error }; }
      return getLoddEngagement(period);
   }
}

export default getLoddPages;
