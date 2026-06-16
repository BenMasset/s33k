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
 *                  (optional, defaults to http://localhost:3000)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API_KEY = process.env.S33K_API_KEY;
const BASE_URL = (process.env.S33K_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

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
      description:
         'List every domain tracked in s33k, each with its name and settings. Use this first to discover which domains exist before calling any domain-scoped tool.',
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
         'List a domain\'s tracked keywords with each keyword\'s current Google rank, ranking URL, target page, and last-7-days rank history. Use this to read SEO standings, get keyword IDs for update_keyword or delete_keyword, or check whether a keyword has scraped yet.',
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
         'Add one keyword to track for a domain and queue a background Google SERP scrape, so its rank appears shortly after. Use this to start tracking a search term, ideally passing target_page so the keyword joins to a page in page_scoreboard. To add many keywords at once, call this tool once per keyword.',
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
         'Re-scrape live Google rankings for keywords that may be stale. Pass either a list of keyword IDs or a single domain to refresh all of its keywords, but not both. A small batch scrapes synchronously and returns updated ranks; a larger batch runs in the background, so re-read with list_keywords shortly after.',
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
         'Read Google Search Console insight for a domain: its top pages, top keywords, top countries, and aggregate stats. Use this for real impression and click data straight from Google, beyond the keywords you explicitly track. Requires Search Console to be connected for the domain in s33k, otherwise it returns an error.',
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
         'Join per-page traffic with tracked keywords for a domain, the core SEO-plus-analytics view. Use this to see which pages earn traffic, what each ranks for, and where the gaps are. Returns a per-page scoreboard (traffic plus the keywords targeting each page, sorted by page views), pages that have traffic but no tracked keyword (a content-gap signal), and keywords whose target page matched no analytics page. Each page row also carries aiReferralVisitors (AI-engine-referred visitors that landed on that page) when the analytics provider exposes per-landing-page referral detail; when it does not, aiReferralVisitors is 0 and aiReferralNote explains it. Per-page bounce_rate and avg_duration may be null when the provider (e.g. Umami) cannot report them at page grain; metricsNote explains the null.',
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
         'Report which AI engines (ChatGPT, Perplexity, Gemini, Claude, Copilot, and more) are sending real visitors to a domain. Use this to measure AEO outcomes: actual traffic that AI answer engines drove. It reads analytics REFERRAL data and never queries an LLM. Returns a per-engine breakdown (visitors and page views, sorted by visitors) plus totals: AI visitors, all referred visitors, and the AI share of referred traffic.',
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
         'Report which AI answer-engine and search crawlers (GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended, Bingbot, and more) are crawling a domain. Use this as the leading indicator of AEO: AI bots crawl a site before any AI engine starts citing it or sending visitors, so this shows up before ai_referrals does. It reads recorded crawler hits (server-log or user-agent ingest) and never queries an LLM. Returns a per-bot breakdown (bot, owner, isAiEngine, hits, lastSeen, sorted by hits), totals (aiEngineHits, allCrawlerHits), and a recent sample of hits.',
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
// ai_visibility
// ---------------------------------------------------------------------------
server.registerTool(
   'ai_visibility',
   {
      title: 'AI visibility funnel',
      description:
         'Measure a domain\'s standing in AI search (ChatGPT, Claude, Perplexity, Gemini, Copilot, and more) using ONLY '
         + 'first-party, un-gameable behavior s33k already records: which AI engines CRAWL the site and which AI engines '
         + 'actually REFER traffic. It never queries an LLM and never asks an AI engine whether it cites the site, so the '
         + 'signal cannot be gamed. Use this to answer "how visible am I in AI search, and where is the gap?" The novel '
         + 'output is the FUNNEL between crawl (an AI engine is learning about you, the leading indicator) and referral '
         + '(an AI engine is recommending you, the outcome), per engine and per page. Returns: pages[] each with a status '
         + 'of "ai-visible" (crawled AND cited: the goal), "crawled-not-cited" (AI knows the page but does not recommend '
         + 'it yet, the prime opportunity), "cited-not-crawled" (rare), or "ai-invisible" (no AI crawl at all); engines[] '
         + 'each with a status of "advocate" (crawls and refers), "aware-not-recommending" (crawls, no referrals yet), or '
         + '"absent"; and a summary (totalAICrawls, totalAIReferrals, crawlToReferralRate, topAdvocate engine, and the '
         + 'biggestGap engine). Read crawled-not-cited pages and aware-not-recommending engines as the work to do. Note: '
         + 'when the analytics provider reports referrals only site-wide (no landing page), per-page isCited cannot be '
         + 'attributed, so pages show isCited=false while engine-level referrals and the totals stay accurate (the note '
         + 'field flags this). When first-party crawl/referral data is thin, the response also includes a deterministic '
         + 'citabilityAudit that fetches the top pages and scores their AI-readiness (llms.txt, Markdown twins, JSON-LD, '
         + 'answer-shaped content) as a leading indicator. This complements ai_crawlers (raw crawl detail) and '
         + 'ai_referrals (raw referral detail) by joining them into one funnel.',
      inputSchema: {
         domain: z.string().describe('The domain to measure AI-search visibility for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/ai-visibility', { query });
         return jsonResult(data);
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
         'Get site-wide traffic totals for a domain over a window: pageviews, unique visitors, visits, bounce rate (percent), average visit duration (seconds), and pages per visit. Use this for the one-line health check of a site before drilling into traffic_breakdown, traffic_timeseries, or page_scoreboard.',
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
// human_traffic
// ---------------------------------------------------------------------------
server.registerTool(
   'human_traffic',
   {
      title: 'Human vs bot traffic estimate',
      description:
         'Estimate how much of a domain\'s traffic is likely humans versus likely bots. Use this to sanity-check the other traffic numbers, because most analytics (including Lodd) overcount automated traffic: JavaScript-executing scrapers run the tracking script and get counted as real visitors (for example heavy Hong Kong, Singapore, and China datacenter traffic at roughly 99 to 100 percent bounce with near-zero time on page). It applies a behavior heuristic (bounce at or above 99 percent AND average duration under 15 seconds across page rows) with a known-human referrer floor (search, social, AI, and email visitors are never flagged as bots). Returns estVisitors, estHumanVisitors, estBotVisitors, botSharePct, and method. This is an ESTIMATE, not an exact count: it separates likely humans from likely bots by aggregate behavior, not per session.',
      inputSchema: {
         domain: z.string().describe('The domain to estimate human vs bot traffic for, e.g. "getmasset.com".'),
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
         const data = await s33kFetch('/api/human-traffic', { query });
         return jsonResult({ estimate: data.estimate, error: data.error });
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
         'Break a domain\'s traffic down by a single dimension. Use this to answer where visitors come from or what they use. The country, device, browser, and os dimensions work on every provider; region, city, language, and screen are Umami-only extras (Lodd returns a "Not supported by Lodd" error for them). Each row has a name, page views, and unique visitors.',
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
         'Get a daily (or unit-grouped) time series of pageviews and visitors for a domain over a window. Use this to spot trends, spikes, and drops over time, or to compare two periods. Each point has a date label, pageviews, and visitors.',
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
         'List a domain\'s custom or tracked events over a window with their fire counts. Use this to see which tracked actions (signups, clicks, downloads, and the like) fired most. Each row has an event name and a count; the list is empty when the site records no custom events.',
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
         'Break a domain\'s sessions into engagement tiers (such as bounced, browsed, and engaged) over a window. Use this to judge traffic quality, not just volume: a high bounced share signals low-quality or bot traffic. Each tier has a label, session count, percentage of all sessions, and (where available) average duration and average pages per session. Lodd serves these directly; Umami derives them from stats.',
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
// top_clicks
// ---------------------------------------------------------------------------
server.registerTool(
   'top_clicks',
   {
      title: 'Top clicks',
      description:
         'List the most-clicked elements on a domain from s33k autocapture, the GA4-killer feature: one script tag on the '
         + 'site captures every button and link click with ZERO per-element setup (no tag manager, no instrumentation). Use '
         + 'this to see which CTAs, nav links, and buttons actually get clicked. Each row has the element\'s visible text '
         + '(label), a stable CSS selector, the total clickCount, and a per-page breakdown (byPage) of where it was clicked, '
         + 'sorted by clickCount. Privacy: this reports THAT an element was clicked and its visible text/selector, NEVER any '
         + 'value typed into an input. Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report top clicks for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/top-clicks', { query });
         return jsonResult({ domain: data.domain, period: data.period, clicks: data.clicks, error: data.error });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// form_submissions
// ---------------------------------------------------------------------------
server.registerTool(
   'form_submissions',
   {
      title: 'Form submissions',
      description:
         'Report form-submission activity on a domain from s33k autocapture: which forms get submitted, how often, and from '
         + 'which pages, with ZERO per-form setup (the single script tag captures submits automatically). Use this to measure '
         + 'conversion or funnel health, signup volume, and contact-form engagement. Returns forms[] (each with the form '
         + 'id/name as label, submissionCount, and a per-page byPage breakdown, sorted by count) plus totalSubmissions. '
         + 'Privacy: this records THAT a form was submitted and its id/name, NEVER any field value or anything typed. '
         + 'Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report form submissions for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/form-submissions', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            forms: data.forms,
            totalSubmissions: data.totalSubmissions,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// scroll_depth
// ---------------------------------------------------------------------------
server.registerTool(
   'scroll_depth',
   {
      title: 'Scroll depth',
      description:
         'Report how far visitors scroll on a domain\'s pages from s33k autocapture, with ZERO setup. Use this to find which '
         + 'pages get read deeply versus abandoned at the top, and whether long pages hold attention. Returns pages[] (each '
         + 'with the page path, avgScrollDepth and maxScrollDepth as percent of page scrolled, and the session count, sorted '
         + 'by avgScrollDepth) plus a site-wide distribution histogram bucketed 0-25 / 25-50 / 50-75 / 75-100 percent. '
         + 'Scroll depth is the max percent reached per session/page. Cookieless, no PII. Reads the first-party event store; '
         + 'never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report scroll depth for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/scroll-depth', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            pages: data.pages,
            distribution: data.distribution,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// page_engagement
// ---------------------------------------------------------------------------
server.registerTool(
   'page_engagement',
   {
      title: 'Page engagement time',
      description:
         'Report active engagement (dwell) time per page on a domain from s33k autocapture, with ZERO setup. Use this to see '
         + 'which pages truly hold attention versus which bounce, beyond raw pageviews. Returns pages[] (each with the page '
         + 'path, avgEngagementSeconds and totalEngagementSeconds, and the unique session count, sorted by total) plus a '
         + 'site-wide siteAvgEngagementSeconds. Engagement is ACTIVE time only: the client pauses the timer when the tab is '
         + 'hidden, the window loses focus, or the visitor goes idle, so this is real attention, not a tab left open. '
         + 'Cookieless, no PII. Reads the first-party event store; never queries an LLM.',
      inputSchema: {
         domain: z.string().describe('The domain to report page engagement for, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/page-engagement', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            pages: data.pages,
            siteAvgEngagementSeconds: data.siteAvgEngagementSeconds,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// insights
// ---------------------------------------------------------------------------
server.registerTool(
   'insights',
   {
      title: 'Cross-pillar insights',
      description:
         'Get a ready-made cross-pillar analysis for a domain in one call. Use this when you want the highest-leverage findings without running each tool yourself. It joins all three s33k pillars (SEO rank, analytics traffic, AI referrals, and engagement) and returns RULES-BASED structured findings and recommendations for YOU (the LLM) to interpret and narrate. The s33k server does NOT call any LLM; it does the joins and surfaces signals dashboards bury. Findings include high-traffic pages with poor or no keyword rank (an SEO opportunity), keywords ranking well but on low-traffic pages (a demand or click-through mismatch), pages and engines receiving AI answer-engine referral traffic (AEO proof), traffic concentrated on a single page (a resilience risk), and an estimated-bot-traffic caveat (how much measured traffic is likely automated, so the other numbers can be read correctly). Each finding has a type, severity, message, and evidence; recommendations is a prioritized list of concrete next actions.',
      inputSchema: {
         domain: z.string().describe('The domain to analyze, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "90d", "7d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/insights', { query });
         return jsonResult({
            domain: data.domain,
            period: data.period,
            findings: data.findings,
            recommendations: data.recommendations,
            notes: data.notes,
            error: data.error,
         });
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// briefing
// ---------------------------------------------------------------------------
server.registerTool(
   'briefing',
   {
      title: 'Daily briefing',
      description:
         'Get a single proactive, cross-pillar "daily standup" for a domain: what changed and, more importantly, what to DO about it. Use this as your FIRST call each day or whenever the user asks "how is my site doing?" or "what should I work on?" It composes every s33k pillar (traffic, human-vs-bot reality, SEO rank and opportunity pages, AI visibility from referrals + crawlers, and engagement) into one ready-to-narrate structure: a headline, sections (each a titled list of plain-English points covering traffic/human-vs-bot, search rank and opportunity pages, AI visibility, and engagement), and the top 3 recommended actions in priority order. The s33k server does NOT call any LLM; it does the joins and the prioritization with transparent rules. YOU (the connected LLM) read this and narrate it as a morning standup, leading with the headline and the recommendations. It never fails on a missing signal: a dead provider or empty data degrades one section instead of the whole briefing.',
      inputSchema: {
         domain: z.string().describe('The domain to brief on, e.g. "getmasset.com".'),
         period: z
            .string()
            .optional()
            .describe('Reporting window, e.g. "30d", "7d", "90d". Defaults to "30d".'),
      },
   },
   async ({ domain, period }) => {
      try {
         const query: Record<string, string> = { domain };
         if (period) { query.period = period; }
         const data = await s33kFetch('/api/briefing', { query });
         return jsonResult({
            headline: data.headline,
            sections: data.sections,
            recommendations: data.recommendations,
            generatedFor: data.generatedFor,
            error: data.error,
         });
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
         'Add one or more domains to track in s33k. Use this once per site before adding its keywords or reading its analytics. Pass bare domain names (for example "getmasset.com"), not full URLs.',
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
         'Update one or more tracked keywords by ID. Use this to set a keyword\'s target_page (the page that should rank for it) so it joins correctly in page_scoreboard, or to toggle its sticky pin. Get the IDs from list_keywords first. Exactly one of target_page or sticky is applied per call, and target_page takes precedence if both are given.',
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
         'Permanently delete one or more tracked keywords by ID. Use this to stop tracking terms you no longer care about. Get the IDs from list_keywords first. This cannot be undone, so confirm the IDs before calling. Returns how many keywords were removed.',
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

// ---------------------------------------------------------------------------
// discover_pages
// ---------------------------------------------------------------------------
server.registerTool(
   'discover_pages',
   {
      title: 'Discover pages',
      description:
         'Crawl a domain and return a compact summary of each important page, the fastest way to onboard a new site. Use this at the start so you can map keywords to real pages instead of guessing. s33k crawls the domain (sitemap.xml first, then homepage links) and returns url, path, title, meta description, h1 and h2 headings, and a short text excerpt per page. No server-side LLM is used and no API key is needed: YOU (the connected LLM) read these summaries, infer what each page is about, propose 1 to 2 target keywords per important page, and call add_keyword for each (passing the page path as target_page). Capped at 25 pages. Never throws; per-page or top-level failures come back as an "error" field.',
      inputSchema: {
         domain: z.string().describe('The domain to read pages from, e.g. "getmasset.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/discover', { query: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// onboard
// ---------------------------------------------------------------------------
server.registerTool(
   'onboard',
   {
      title: 'Onboard a domain',
      description:
         'Give me a domain and I set up everything for it in one call, the fastest way to go from nothing to live data. s33k will: create the domain, crawl a few of its pages and heuristically discover candidate target keywords (no LLM needed), add up to 20 of them and immediately queue background Google rank scrapes (rankings appear shortly, so rankingsPending comes back true), provision a dedicated analytics website for the domain, and return the tracking snippet plus copy-paste install guides for common platforms (raw HTML, Google Tag Manager, WordPress, Webflow, Shopify, Squarespace, Wix, Next.js/React). Pass a bare domain like "getmasset.com", not a full URL. Use this as the first thing you do for a brand new site. Degrades gracefully: if analytics provisioning is unavailable, umamiWebsiteId comes back null with a note while the domain, keywords, and rankings are still set up. Returns { domain, discoveredKeywords, addedKeywords, rankingsPending, umamiWebsiteId, installSnippet, installGuides, note }.',
      inputSchema: {
         domain: z.string().describe('The bare domain to onboard, e.g. "getmasset.com". No protocol, no path.'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/onboard', { method: 'POST', body: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// install_instructions
// ---------------------------------------------------------------------------
server.registerTool(
   'install_instructions',
   {
      title: 'Install instructions',
      description:
         'Show how to add the s33k analytics tracking code to a site, including the exact snippet and step-by-step instructions for the user\'s platform. Use this when someone asks "how do I add the tracking code on <platform>" (WordPress, Webflow, Shopify, Squarespace, Wix, Google Tag Manager, Next.js/React, or raw HTML), or any time after onboarding when they need the snippet again. The domain must already be onboarded. Returns { domain, umamiWebsiteId, installSnippet, installGuides } where installGuides.platforms is a list of { platform, steps }. Read the steps for the platform the user named and walk them through it.',
      inputSchema: {
         domain: z.string().describe('The already-onboarded domain, e.g. "getmasset.com".'),
      },
   },
   async ({ domain }) => {
      try {
         const data = await s33kFetch('/api/install-instructions', { query: { domain } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// invite_external
// ---------------------------------------------------------------------------
server.registerTool(
   'invite_external',
   {
      title: 'Invite an external user (new account)',
      description:
         'Send an EXTERNAL invite that brings a brand-new admin and their own account into s33k, the viral growth lever. '
         + 'Use this to invite someone OUTSIDE your organization to start using s33k for their own domain. The person who '
         + 'accepts becomes the admin of a NEW account and gets their own admin API key. External invites are LIMITED: each '
         + 'account has a quota (default 5), so this can fail with "External invite quota exhausted." once you have used '
         + 'yours. An email is required so the invite can be delivered (sent automatically when email is configured on the '
         + 'server, otherwise share the returned link yourself). Returns { code, link, type, emailSent }: give the link or '
         + 'code to the recipient so they can activate. Requires an admin API key; a read-only member key is rejected.',
      inputSchema: {
         email: z.string().describe('The email address of the person to invite, e.g. "jane@company.com". Required.'),
      },
   },
   async ({ email }) => {
      try {
         const data = await s33kFetch('/api/invite', { method: 'POST', body: { type: 'external', email } });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// invite_internal
// ---------------------------------------------------------------------------
server.registerTool(
   'invite_internal',
   {
      title: 'Invite an internal teammate (read-only seat)',
      description:
         'Send an INTERNAL invite that adds a read-only MEMBER seat to YOUR OWN account, for a teammate who should see your '
         + 'domains, rankings, analytics, and AI visibility but not change anything. Use this to bring a colleague onto your '
         + 'existing account. The person who accepts gets a read-only member API key scoped to your account (member keys can '
         + 'only read, never write). Internal invites are UNLIMITED (they do not consume your external quota). An email is '
         + 'optional: pass one to have the invite delivered automatically (when email is configured on the server), or omit '
         + 'it and share the returned link yourself. Returns { code, link, type, emailSent }. Requires an admin API key; a '
         + 'read-only member key is rejected.',
      inputSchema: {
         email: z
            .string()
            .optional()
            .describe('Optional email of the teammate to invite, e.g. "team@company.com". If given, the invite is emailed.'),
      },
   },
   async ({ email }) => {
      try {
         const body: Record<string, unknown> = { type: 'internal' };
         if (email) { body.email = email; }
         const data = await s33kFetch('/api/invite', { method: 'POST', body });
         return jsonResult(data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// list_invites
// ---------------------------------------------------------------------------
server.registerTool(
   'list_invites',
   {
      title: 'List invites you have sent',
      description:
         'List every invite your account has created, both external and internal, the way Gmail shows your sent invites. '
         + 'Use this to see who you have invited, which invites are still pending, which have been accepted, and how many '
         + 'external invites you have used against your quota. Returns { invites } where each invite has ID, code, type '
         + '("external" or "internal"), email, status ("pending", "accepted", "expired", or "revoked"), target_account_id, '
         + 'created, and accepted_at. Requires an admin API key; a read-only member key is rejected.',
      inputSchema: {},
   },
   async () => {
      try {
         const data = await s33kFetch('/api/invite');
         return jsonResult(data.invites ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

// ---------------------------------------------------------------------------
// list_waitlist
// ---------------------------------------------------------------------------
server.registerTool(
   'list_waitlist',
   {
      title: 'List waitlist signups (admin only)',
      description:
         'List everyone who has signed up for the s33k waitlist, so you can decide who to send external invites to. Use '
         + 'this to review pending demand before inviting people in. Returns { waitlist } where each row has ID, email, '
         + 'domain, note, status ("waiting" or "invited"), and created. This is restricted to the root admin account: a '
         + 'non-admin or read-only member key is rejected with an admin-required error.',
      inputSchema: {},
   },
   async () => {
      try {
         const data = await s33kFetch('/api/waitlist');
         return jsonResult(data.waitlist ?? data);
      } catch (err) {
         return errorResult(err);
      }
   },
);

async function main() {
   const transport = new StdioServerTransport();
   await server.connect(transport);
   process.stderr.write(`s33k-mcp connected (base URL: ${BASE_URL}). 31 tools registered.\n`);
}

main().catch((err) => {
   process.stderr.write(`s33k-mcp fatal: ${err instanceof Error ? err.message : String(err)}\n`);
   process.exit(1);
});
