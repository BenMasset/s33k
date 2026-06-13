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
 *   LODD_API_KEY   Bearer token for the Lodd API (required)
 *   LODD_SITE      The Lodd site UUID to read traffic for (required)
 *   LODD_BASE_URL  Base URL of the Lodd API (optional, defaults to https://api.lodd.dev/v1)
 */

import type {
   AnalyticsProvider, AnalyticsResult, NormalizedPage, ReferralResult, ReferralSource,
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

/**
 * Lodd implementation of the AnalyticsProvider interface.
 * Wraps getLoddPages. A LoddPage already satisfies NormalizedPage (its extra
 * fields are the optional ones), so the page list passes straight through.
 * The `domain` argument is unused: Lodd is keyed by LODD_SITE, not by domain.
 */
export class LoddProvider implements AnalyticsProvider {
   // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
   async getPageTraffic(_domain: string, period = '30d'): Promise<AnalyticsResult> {
      const { pages, error } = await getLoddPages(period);
      return { pages: pages as NormalizedPage[], error };
   }

   // eslint-disable-next-line class-methods-use-this, @typescript-eslint/no-unused-vars
   async getReferralSources(_domain: string, period = '90d'): Promise<ReferralResult> {
      return getLoddReferrals(period);
   }
}

export default getLoddPages;
