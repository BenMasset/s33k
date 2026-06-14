#!/usr/bin/env node
/**
 * s33k MCP server.
 *
 * Exposes s33k (an open, self-hosted SEO/AEO rank tracker forked from SerpBear)
 * to an LLM over the Model Context Protocol, speaking stdio transport.
 *
 * Every tool is a thin wrapper over the s33k REST API. Authentication uses the
 * s33k Bearer API key, so the server runs fully headless with no login cookie.
 *
 * Configuration comes from two environment variables:
 *   S33K_API_KEY   the value of APIKEY in the s33k .env file (required)
 *   S33K_BASE_URL  the base URL of the running s33k instance
 *                  (optional, defaults to http://localhost:3005)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.S33K_API_KEY;
const BASE_URL = (process.env.S33K_BASE_URL || 'http://localhost:3005').replace(/\/$/, '');

if (!API_KEY) {
   // Write to stderr (stdout is reserved for the MCP protocol) and exit.
   process.stderr.write('s33k-mcp: S33K_API_KEY environment variable is required.\n');
   process.exit(1);
}

/**
 * Call the s33k REST API with the Bearer API key.
 * Returns the parsed JSON body. Throws on non-2xx so each tool can surface the error.
 */
async function s33kFetch(
   path: string,
   options: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<any> {
   const { method = 'GET', query, body } = options;
   const url = new URL(`${BASE_URL}${path}`);
   if (query) {
      for (const [key, value] of Object.entries(query)) {
         if (value !== undefined && value !== null && value !== '') {
            url.searchParams.set(key, value);
         }
      }
   }

   const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
   if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
   }

   const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
   });

   const text = await res.text();
   let parsed: any = null;
   try {
      parsed = text ? JSON.parse(text) : null;
   } catch {
      parsed = text;
   }

   if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' && parsed.error ? parsed.error : text;
      throw new Error(`s33k API ${method} ${path} failed (${res.status}): ${detail}`);
   }
   return parsed;
}

/** Wrap any value as a single text content block of pretty JSON. */
function jsonResult(value: unknown) {
   return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Wrap an error as an MCP tool error result rather than throwing out of the handler. */
function errorResult(err: unknown) {
   const message = err instanceof Error ? err.message : String(err);
   return { isError: true, content: [{ type: 'text' as const, text: message }] };
}

const server = new McpServer({
   name: 's33k-mcp',
   version: '0.1.0',
});

// ---------------------------------------------------------------------------
// list_domains
// ---------------------------------------------------------------------------
server.registerTool(
   'list_domains',
   {
      title: 'List domains',
      description: 'List all domains tracked in s33k. Returns each domain with its name and settings.',
      inputSchema: {},
   },
   async () => {
      try {
         const data = await s33kFetch('/api/domains');
         return jsonResult(data.domains ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// list_keywords
// ---------------------------------------------------------------------------
server.registerTool(
   'list_keywords',
   {
      title: 'List keywords',
      description:
         'List the tracked keywords for a domain, with current Google rank, ranking URL, target page, and recent rank history (last 7 days).',
      inputSchema: {
         domain: z.string().describe('The domain to list keywords for, e.g. "getmasset.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/keywords', { query: { domain } });
         const keywords = (data.keywords ?? []).map((k: any) => ({
            ID: k.ID,
            keyword: k.keyword,
            device: k.device,
            country: k.country,
            position: k.position,
            url: k.url,
            target_page: k.target_page ?? '',
            history: k.history,
         }));
         return jsonResult(keywords);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// add_keyword
// ---------------------------------------------------------------------------
server.registerTool(
   'add_keyword',
   {
      title: 'Add keyword',
      description:
         'Add a new keyword to track for a domain. Queues a SERP scrape in the background, so the rank appears shortly after adding.',
      inputSchema: {
         keyword: z.string().describe('The search keyword/phrase to track.'),
         domain: z.string().describe('The domain to track this keyword for, e.g. "getmasset.com".'),
         country: z
            .string()
            .default('US')
            .describe('Two-letter country code for the search, e.g. "US". Defaults to "US".'),
         device: z
            .enum(['desktop', 'mobile'])
            .default('desktop')
            .describe('Device to track rankings for. Defaults to "desktop".'),
         target_page: z
            .string()
            .optional()
            .describe('Optional target page path/URL this keyword should rank for, e.g. "/software/mcp".'),
      },
   },
   async ({ keyword, domain, country, device, target_page }) => {
      try {
         const payload = {
            keywords: [
               {
                  keyword,
                  domain,
                  country,
                  device,
                  target_page: target_page ?? '',
               },
            ],
         };
         const data = await s33kFetch('/api/keywords', { method: 'POST', body: payload });
         return jsonResult(data.keywords ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// refresh_keywords
// ---------------------------------------------------------------------------
server.registerTool(
   'refresh_keywords',
   {
      title: 'Refresh keywords',
      description:
         'Trigger a fresh SERP scrape for keywords. Provide either a list of keyword IDs, or a domain to refresh all of its keywords. A small batch scrapes synchronously; larger batches run in the background.',
      inputSchema: {
         ids: z
            .array(z.number().int())
            .optional()
            .describe('Keyword IDs to refresh. Use this OR "domain", not both.'),
         domain: z
            .string()
            .optional()
            .describe('Refresh every keyword for this domain. Use this OR "ids", not both.'),
      },
   },
   async ({ ids, domain }) => {
      try {
         if ((!ids || ids.length === 0) && !domain) {
            return errorResult(new Error('Provide either "ids" (one or more keyword IDs) or "domain".'));
         }
         let query: Record<string, string>;
         if (ids && ids.length > 0) {
            query = { id: ids.join(',') };
         } else {
            query = { id: 'all', domain: domain as string };
         }
         const data = await s33kFetch('/api/refresh', { method: 'POST', query });
         return jsonResult(data.keywords ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// get_insight
// ---------------------------------------------------------------------------
server.registerTool(
   'get_insight',
   {
      title: 'Get Search Console insight',
      description:
         'Get Google Search Console insight for a domain: top pages, top keywords, countries, and stats. Requires Search Console to be connected for the domain in s33k.',
      inputSchema: {
         domain: z.string().describe('The domain to get insight for, e.g. "getmasset.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/insight', { query: { domain } });
         return jsonResult(data.data ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// page_scoreboard
// ---------------------------------------------------------------------------
server.registerTool(
   'page_scoreboard',
   {
      title: 'Page scoreboard',
      description:
         'Join per-page traffic (from Lodd analytics) with tracked keywords for a domain. Returns a per-page scoreboard (traffic plus the keywords targeting each page, sorted by page views), pages that have traffic but no tracked keyword (a content-gap signal), and keywords whose target page matched no analytics page.',
      inputSchema: {
         domain: z.string().describe('The domain to build the scoreboard for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window for analytics, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/scoreboard', { query });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// ai_referrals
// ---------------------------------------------------------------------------
server.registerTool(
   'ai_referrals',
   {
      title: 'AI referrals',
      description:
         'Report which AI engines (ChatGPT, Perplexity, Gemini, Claude, Copilot, etc.) are sending real visitors to a domain, measured from analytics REFERRAL data (not by querying any LLM). Returns a per-engine breakdown (visitors and page views, sorted desc) plus totals: AI visitors, all referred visitors, and the AI share of referred traffic.',
      inputSchema: {
         domain: z.string().describe('The domain to report AI referrals for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window for analytics, e.g. "90d", "30d". Defaults to "90d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/ai-referrals', { query });
         return jsonResult({ byEngine: data.byEngine, totals: data.totals, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// ai_crawlers
// ---------------------------------------------------------------------------
server.registerTool(
   'ai_crawlers',
   {
      title: 'AI crawlers',
      description:
         'Report which AI answer-engine and search crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Bingbot, etc.) are crawling a domain. This is the leading indicator of AEO: AI bots crawl a site before any AI engine starts citing it or sending visitors. Measured from recorded crawler hits (server-log / user-agent ingest), not by querying any LLM. Returns a per-bot breakdown (bot, owner, isAiEngine, hits, lastSeen, sorted by hits desc), totals (aiEngineHits, allCrawlerHits), and a recent sample of hits.',
      inputSchema: {
         domain: z.string().describe('The domain to report AI crawler activity for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/ai-crawlers', { query });
         return jsonResult({ byBot: data.byBot, totals: data.totals, recent: data.recent, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// traffic_summary
// ---------------------------------------------------------------------------
server.registerTool(
   'traffic_summary',
   {
      title: 'Traffic summary',
      description:
         'Site-wide traffic totals for a domain over a window: pageviews, unique visitors, visits, bounce rate (percent), average visit duration (seconds), and pages per visit.',
      inputSchema: {
         domain: z.string().describe('The domain to summarize, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/summary', { query });
         return jsonResult({ summary: data.summary, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// traffic_breakdown
// ---------------------------------------------------------------------------
server.registerTool(
   'traffic_breakdown',
   {
      title: 'Traffic breakdown',
      description:
         'Break traffic down by a single dimension for a domain. country/device/browser/os work on every provider; region/city/language/screen are Umami-only extras (Lodd returns a "Not supported by Lodd" error for them). Each row has a name, page views, and unique visitors.',
      inputSchema: {
         domain: z.string().describe('The domain to break down, e.g. "getmasset.com".'),
         dimension: z
            .enum(['country', 'region', 'city', 'device', 'browser', 'os', 'language', 'screen'])
            .describe('Which dimension to break traffic down by.'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, dimension, period }) => {
      try {
         const query: Record<string, string> = { domain, dimension };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/breakdown', { query });
         return jsonResult({ dimension: data.dimension, rows: data.rows, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// traffic_timeseries
// ---------------------------------------------------------------------------
server.registerTool(
   'traffic_timeseries',
   {
      title: 'Traffic time series',
      description:
         'Daily (or unit-grouped) time series of pageviews and visitors for a domain over a window. Each point has a date label, pageviews, and visitors.',
      inputSchema: {
         domain: z.string().describe('The domain to chart, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
         unit: z
            .string()
            .optional()
            .describe('Bucket unit, e.g. "day". Defaults to "day".'),
      },
   },
   async ({ domain, period, unit }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         if (unit) { query.unit = unit; }
         const data = await s33kFetch('/api/timeseries', { query });
         return jsonResult({ unit: data.unit, series: data.series, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// top_events
// ---------------------------------------------------------------------------
server.registerTool(
   'top_events',
   {
      title: 'Top events',
      description:
         'Custom/tracked events for a domain over a window, with their fire counts. Each row has an event name and a count.',
      inputSchema: {
         domain: z.string().describe('The domain to list events for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/events', { query });
         return jsonResult({ events: data.events, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// engagement
// ---------------------------------------------------------------------------
server.registerTool(
   'engagement',
   {
      title: 'Engagement tiers',
      description:
         'Session-quality engagement tiers (e.g. bounced / browsed / engaged) for a domain over a window. Each tier has a label, session count, percentage of all sessions, and (where available) average duration and average pages per session. Lodd serves these directly; Umami derives them from stats.',
      inputSchema: {
         domain: z.string().describe('The domain to measure engagement for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/engagement', { query });
         return jsonResult({ tiers: data.tiers, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// create_domain
// ---------------------------------------------------------------------------
server.registerTool(
   'create_domain',
   {
      title: 'Create domain',
      description:
         'Add one or more domains to track in s33k. Pass bare domain names (e.g. "getmasset.com"), not full URLs.',
      inputSchema: {
         domains: z
            .array(z.string())
            .min(1)
            .describe('Domain names to add, e.g. ["getmasset.com"]. Bare hostnames, no protocol.'),
      },
   },
   async ({ domains }) => {
      try {
         const data = await s33kFetch('/api/domains', { method: 'POST', body: { domains } });
         return jsonResult(data.domains ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// update_keyword
// ---------------------------------------------------------------------------
server.registerTool(
   'update_keyword',
   {
      title: 'Update keyword',
      description:
         'Update one or more tracked keywords by ID. Set the target_page (the page that should rank for the keyword) and/or toggle sticky. Exactly one of target_page or sticky is applied per call (target_page takes precedence if both are given).',
      inputSchema: {
         ids: z
            .array(z.number().int())
            .min(1)
            .describe('Keyword IDs to update.'),
         target_page: z
            .string()
            .optional()
            .describe('The target page path/URL this keyword should rank for, e.g. "/software/mcp". Pass "" to clear.'),
         sticky: z
            .boolean()
            .optional()
            .describe('Whether to pin the keyword as sticky. Applied only when target_page is not provided.'),
      },
   },
   async ({ ids, target_page, sticky }) => {
      try {
         if (target_page === undefined && sticky === undefined) {
            return errorResult(new Error('Provide target_page and/or sticky to update.'));
         }
         const body: Record<string, unknown> = {};
         if (target_page !== undefined) {
            body.target_page = target_page;
         } else if (sticky !== undefined) {
            body.sticky = sticky;
         }
         const data = await s33kFetch('/api/keywords', {
            method: 'PUT',
            query: { id: ids.join(',') },
            body,
         });
         return jsonResult(data.keywords ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// delete_keyword
// ---------------------------------------------------------------------------
server.registerTool(
   'delete_keyword',
   {
      title: 'Delete keyword',
      description:
         'Permanently delete one or more tracked keywords by ID. Returns how many keywords were removed.',
      inputSchema: {
         ids: z
            .array(z.number().int())
            .min(1)
            .describe('Keyword IDs to delete.'),
      },
   },
   async ({ ids }) => {
      try {
         const data = await s33kFetch('/api/keywords', {
            method: 'DELETE',
            query: { id: ids.join(',') },
         });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

async function main() {
   const transport = new StdioServerTransport();
   await server.connect(transport);
   process.stderr.write(`s33k-mcp connected (base URL: ${BASE_URL}). 16 tools registered.\n`);
}

main().catch((err) => {
   process.stderr.write(`s33k-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
   process.exit(1);
});
