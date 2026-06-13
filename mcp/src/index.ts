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

async function main() {
   const transport = new StdioServerTransport();
   await server.connect(transport);
   process.stderr.write(`s33k-mcp connected (base URL: ${BASE_URL}). 7 tools registered.\n`);
}

main().catch((err) => {
   process.stderr.write(`s33k-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
   process.exit(1);
});
