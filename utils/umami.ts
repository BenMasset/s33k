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
} from './analytics';
import { cleanPath } from './lodd';
import { classifyReferrer } from './ai-sources';

/** Strip a trailing slash and a trailing /api so we can build /api/... cleanly. */
const normalizeBaseUrl = (raw: string): string => {
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
const getToken = async (base: string): Promise<{ token: string | null, error: string | null }> => {
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
 * Uses UMAMI_WEBSITE_ID when set; otherwise lists websites and matches by domain.
 * @param {string} base - Normalized base URL.
 * @param {string} token - Bearer token.
 * @param {string} domain - Site domain, e.g. "getmasset.com".
 * @returns {Promise<{ websiteId: string | null, error: string | null }>}
 */
const resolveWebsiteId = async (
   base: string,
   token: string,
   domain: string,
): Promise<{ websiteId: string | null, error: string | null }> => {
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

   const { websiteId, error: idError } = await resolveWebsiteId(base, token, domain);
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
 * page_views set. unique_visitors / bounce_rate / avg_duration are not provided
 * by the url-type metrics endpoint and are left undefined.
 */
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

      const { websiteId, error: idError } = await resolveWebsiteId(base, token, domain);
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
            return {
               url: rawUrl,
               pathClean: cleanPath(rawUrl),
               page_views: Number(row?.y ?? 0),
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

      const { websiteId, error: idError } = await resolveWebsiteId(base, token, domain);
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
}

export default UmamiProvider;
