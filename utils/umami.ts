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

import type { AnalyticsProvider, AnalyticsResult, NormalizedPage } from './analytics';
import { cleanPath } from './lodd';

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

      const metricsType = (process.env.UMAMI_METRICS_TYPE || 'url').trim();
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
}

export default UmamiProvider;
