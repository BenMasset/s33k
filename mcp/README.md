# s33k MCP server

This is the MCP (Model Context Protocol) control layer for s33k. It lets an LLM client such as Claude Code or Cursor operate s33k entirely over a single connection: track keywords and read live Google rankings, detect AI visibility from referral data, read owned analytics, and pull the cross-pillar briefing and scoreboard.

The server is a thin wrapper over the s33k REST API. It authenticates with the s33k Bearer API key, so it runs fully headless with no login cookie.

There are two ways to connect, and they expose the EXACT same tools (the registrations are shared in `src/tools.ts`):

- **Local (stdio).** Run the compiled `dist/index.js` as a stdio child of your MCP client. Best for a self-hoster who runs s33k themselves. Uses `S33K_API_KEY` from the environment. See [Register it in Claude Code](#register-it-in-claude-code).
- **Hosted (HTTP).** Connect to a running s33k server's `/api/mcp` endpoint with one URL plus a Bearer key. NO local install. Best for sharing: a scoped share key over the hosted endpoint is automatically read-only and single-domain, because the same server-side `authorize()` enforces it per connection. See [Connect over the hosted HTTP endpoint](#connect-over-the-hosted-http-endpoint).

## Tools

The server registers up to 81 tools and 5 knowledge resources, grouped by pillar. The authoritative source is `src/tools.ts` (the shared `registerS33kTools`, used by both transports); the per-tool descriptions live in `utils/knowledge.ts` in the root repo. Most read tools take `domain` and an optional `period` (e.g. `30d`); the per-tool specifics are below.

**Customer vs admin surface.** The DEFAULT surface is customer-only: **69 tools** for a marketer reading their own SEO / analytics / AEO and managing their own tracking. Twelve app-management tools (marked **admin only** below) register ONLY when the operator sets `S33K_MCP_ADMIN=true`, which exposes the full 81-tool surface. With the flag off they are truly absent from `tools/list`, not present-but-erroring, so a customer key never even sees them. Hand customers a default-surface connection; reserve `S33K_MCP_ADMIN=true` for the operator.

### Cross-pillar

| Tool | What it does |
|---|---|
| `briefing` | One proactive daily standup for a domain: a headline, sections, and the top three actions across every pillar. Best first call of the day. |
| `insights` | Cross-pillar analyst. Joins rank, traffic, AI referrals, and engagement into rules-based findings and prioritized recommendations. |
| `alerts` | The "what changed and what to do" standup. Compares this period to the prior one and surfaces rank moves, traffic swings, and new AI engines, plus the top priority. |
| `executive_summary` | The leadership one-glance report: headline numbers, top and top-converting channel, an SEO snapshot, AI visibility, a health line, and the single next action. |
| `weekly_digest` | A week-in-review bundle: traffic, top entry pages, sessions per channel, AI-search sessions, and the keywords that moved most in rank. |
| `page_scoreboard` | Joins per-page traffic with tracked keywords and rank. Flags content-gap pages and keywords whose target page got no traffic. |
| `entry_pages` | Analyzes the ENTRY (landing) pages where sessions start, joining first-touch source split to tracked rank. |
| `entry_page_report` | The entry-page acquisition lens: first-touch sessions per landing page by source channel, joined to the keywords/rank each page holds. |
| `content_performance_report` | Ranks pages by pageviews, joining entries, optional goal conversions, and tracked keywords/rank per page. |
| `conversion_attribution` | Attributes a goal's conversions and revenue by source (AI vs organic vs direct) and by tracked keyword, and names the money moves. |
| `portfolio_summary` | Summarizes every domain on the account in one call: rank distribution, quick-win count, and human plus AI-referral sessions per site. |

### SEO

| Tool | What it does | Arguments |
|---|---|---|
| `discover_pages` | Crawls a domain (sitemap first, then homepage links) and returns up to 25 pages for keyword-to-page mapping. | `domain` |
| `list_keywords` | Lists a domain's keywords with current rank, ranking URL, target page, and recent rank history. | `domain` |
| `add_keyword` | Adds a keyword to track. Queues a background SERP scrape. | `keyword`, `domain`, `country` (default `US`), `device` (`desktop` or `mobile`, default `desktop`), `target_page` (optional) |
| `update_keyword` | Updates keywords by ID: set target page and/or toggle sticky. | `ids`, `target_page` and/or `sticky` |
| `delete_keyword` | Permanently deletes one or more keywords by ID. | `ids` |
| `refresh_keywords` | Triggers a fresh SERP scrape for specific keyword IDs or a whole domain. | `ids` (array of numbers) OR `domain` |
| `striking_distance` | Returns near-miss keywords ranking just off page one (positions 4 to 30), the cheapest SEO wins, each with its position delta. | `domain`, `min`/`max` (optional) |
| `seo_report` | A prebuilt one-call SEO snapshot: rank distribution, striking-distance quick wins, biggest movers, and keywords grouped by target page. | `domain` |
| `site_audit` | Crawls a domain and returns a prioritized on-page / technical issue list (titles, metas, H1s, duplicates, thin content), each with a severity. | `domain` |
| `cannibalization_detection` | Finds keyword cannibalization where two of your own pages compete for the same term and split the equity. | `domain` |
| `content_gap` | Crawls a named competitor and your site and returns the topics the competitor covers that you do not. | `domain`, `competitor` |
| `competitor_visibility` | Reads the stored SERP for every tracked keyword and tallies competitor share of voice, plus who outranks you per keyword. | `domain` |
| `get_insight` | Reads Google Search Console insight (top pages, keywords, countries, stats). Requires GSC connected for that domain. | `domain` |

### AEO

| Tool | What it does | Arguments |
|---|---|---|
| `ai_referrals` | Reports which AI engines send real visitors (per-engine visitors, page views, AI share of referred traffic). | `domain`, `period` (optional) |
| `ai_visibility` | Per-page and per-engine view of AI referrals, flagging not-cited pages, with an AI-readiness audit fallback when referral data is thin. | `domain`, `period` (optional) |
| `aeo_report` | A prebuilt one-call AEO snapshot: AI referrals per engine plus a per-engine summary. | `domain`, `period` (optional) |

### Analytics

| Tool | What it does | Arguments |
|---|---|---|
| `traffic_summary` | Site-wide totals: pageviews, visitors, visits, bounce rate, average duration, pages per visit. | `domain`, `period` (optional) |
| `human_traffic` | Estimates likely-human vs likely-bot traffic via a bounce/duration heuristic with a known-human referrer floor. An estimate, not an exact count. | `domain`, `period` (optional) |
| `human_analytics` | Human-only analytics from s33k's own first-party pageviews (datacenter bots excluded by IP), with exit and bounce rate the Umami view cannot produce. | `domain`, `period` (optional), `includeBots` (optional) |
| `channel_report` | Maps every session to a clean marketing channel (Organic Search, AI Search, Referral, Direct) with sessions and share, plus conversions per channel with a goal. | `domain`, `period` (optional), `goalId` (optional) |
| `campaign_report` | Groups every session by UTM campaign (with utm_source / utm_medium splits) and reports sessions and share, plus conversions per campaign with a goal. | `domain`, `period` (optional), `goalId` (optional) |
| `live_view` | A polled real-time snapshot of who is on the site now: active visitors, pages being viewed, source and country splits, and recent events. | `domain`, `windowMinutes` (optional, default 5) |
| `funnel_analysis` | An ordered, multi-step funnel from first-party sessions with per-step drop-off. | `domain`, `steps`, `period` (optional) |
| `period_compare` | This period vs the immediately-preceding equal-length period, side by side, with delta and percent change per metric. | `domain`, `period` (optional), `goalId` (optional) |
| `traffic_breakdown` | Breaks traffic down by a dimension (country, device, browser, os, plus Umami-only region/city/language/screen). | `domain`, `dimension`, `period` (optional) |
| `traffic_timeseries` | Daily (or unit-grouped) time series of pageviews and visitors. | `domain`, `period` (optional), `unit` (optional) |
| `top_events` | Custom/tracked events with their fire counts. | `domain`, `period` (optional) |
| `engagement` | Session-quality engagement tiers (bounced / browsed / engaged) with counts, percentages, and averages. | `domain`, `period` (optional) |
| `top_clicks` | The most-clicked elements from s33k autocapture, by visible text and stable selector. Never any typed value. | `domain`, `period` (optional) |
| `form_submissions` | Which forms get submitted, how often, and from which pages, from autocapture. Records the form id/name only, never field values. | `domain`, `period` (optional) |
| `scroll_depth` | How far visitors scroll per page plus a site-wide depth histogram, from autocapture. | `domain`, `period` (optional) |
| `page_engagement` | Active engagement (dwell) time per page from autocapture, paused when the tab is hidden or the visitor is idle. | `domain`, `period` (optional) |
| `web_vitals` | Real-user Core Web Vitals (LCP, CLS, INP, FID, FCP, TTFB) at p75 scored against Google's field thresholds, with the slowest pages. | `domain`, `period` (optional) |
| `conversions_by_source` | Attributes conversions (autocaptured form submits by default) to the first-touch source, with an approximate rate per source. | `domain`, `period` (optional), `eventType` (optional) |

### Conversion goals and segments

| Tool | What it does | Arguments |
|---|---|---|
| `create_goal` | Defines a named conversion goal: a destination page reached (`page_reached`) or an autocaptured event fired (`event`). | `domain`, `name`, `kind`, `matchValue`, `value` (optional) |
| `list_goals` | Lists the named conversion goals defined for a domain and their match rules. | `domain` |
| `delete_goal` | Deletes a named conversion goal by its id. | `domain`, `goalId` |
| `goal_analytics` | Conversion rate and counts for a goal, filterable and groupable by source/landing page/device/country/engagement, with revenue when the goal has a value. | `domain`, `goalId`, `period` (optional), filter/groupBy (optional) |
| `suggest_goals` | Proposes ready-to-create goals by spotting a site's likely conversions (thank-you, demo, contact, signup pages). | `domain` |
| `segment_save` | Saves a named, reusable filter set built from the composable analytics filters. | `domain`, `name`, filters |
| `segment_list` | Lists the named segments defined for a domain and the filters each stores. | `domain` |
| `segment_delete` | Deletes a named segment by its id. | `domain`, `id` |
| `segment_analytics` | Applies a saved segment by name (or id) and returns the human-analytics-style traffic summary with its filters applied. | `domain`, `segment` (name or id), `period` (optional) |

### Domains and onboarding

| Tool | What it does | Arguments |
|---|---|---|
| `list_domains` | Lists all domains tracked in s33k. | none |
| `create_domain` | **Admin only.** Adds one or more domains to track (bare hostnames, no protocol). | `domains` |
| `onboard` | **Admin only.** The one-call cold start: creates the domain, discovers and adds keywords with scrapes queued, provisions analytics, and returns the snippet plus guides. | `domain` |
| `setup_status` | Reports a domain's setup progress as a checklist with the single next step and the exact tool to call. | `domain` |
| `install_instructions` | Returns the tracking snippet and per-platform install steps (WordPress, Webflow, Shopify, GTM, Next.js, raw HTML, and more). | `domain`, `platform` (optional) |

### Account, trust, and self-support

| Tool | What it does | Arguments |
|---|---|---|
| `invite_external` | **Admin only.** Sends an external invite that brings a new admin and their own account into s33k (quota-limited). | `email` |
| `invite_internal` | **Admin only.** Adds a read-only member seat to your own account for a teammate (unlimited). | `email` |
| `list_invites` | **Admin only.** Lists every invite you have sent, with status. | none |
| `list_waitlist` | **Admin only.** Lists waitlist signups (root admin only). | none |
| `security_facts` | Returns s33k's complete, source-cited trust facts: no model training, tenant isolation, encryption at rest, cookieless/no-PII. | none |
| `export_data` | Downloads everything s33k holds about your account as one JSON bundle. Never includes a secret. | none |
| `delete_account_data` | **Admin only.** Permanently and irreversibly deletes your entire account and all its data. Requires the confirmation string `DELETE`. | `confirm` |
| `help` | Answers any question about s33k from its single authoritative product-knowledge layer. Reads no account data and never queries an LLM. | `question`, `topic` (optional) |
| `request_feature` | **Admin only.** Submits a request for a capability s33k does not have (after `help` confirms it is genuinely missing). | `request` |
| `list_feature_requests` | **Admin only.** Lists submitted feature requests (root admin only). | `status` (optional) |

The twelve **admin only** tools above (`create_domain`, `onboard`, `invite_external`, `invite_internal`, `list_invites`, `list_waitlist`, `share_domain`, `list_domain_shares`, `revoke_domain_share`, `delete_account_data`, `request_feature`, `list_feature_requests`) register ONLY when `S33K_MCP_ADMIN=true`. On the default customer surface they are absent. Separately, the multi-tenant access tiers (`invite_*`, the share tools, member keys) take effect when `MULTI_TENANT` is on; write tools require an admin key and read-only member keys are rejected at the API.

### Knowledge resources

Five read-only MCP resources expose the same product-knowledge layer the `help` tool reads, so a client can pull a whole doc into context with `resources/read`: `knowledge://capabilities`, `knowledge://setup`, `knowledge://reasoning`, `knowledge://troubleshooting`, and `knowledge://trust`.

## Trust property

s33k makes no server-side LLM calls. The AI features (`briefing`, `insights`, `ai_visibility`, `alerts`, `entry_pages`, and the prebuilt reports) are rules-based: the server computes structured findings over your own data and hands them to your own LLM to narrate. There is no model-training path, tracking is cookieless with no PII, and s33k is self-hostable so you can verify all of it. See `SECURITY.md`, or ask via the `security_facts` tool.

## Requirements

- Node 20 (the s33k repo pins Node 20 via `.nvmrc`; native deps are built for it). The MCP SDK requires Node 18 or newer, so Node 20 is fine.
- A running s33k instance. By default the server talks to `http://localhost:3000`. Set `S33K_BASE_URL` to match how you run s33k (for example `http://localhost:3000` for the local Quickstart, or `http://localhost:8080` for the docker-compose stack).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `S33K_API_KEY` | yes | none | The value of `APIKEY` in the s33k root `.env` file. |
| `S33K_BASE_URL` | no | `http://localhost:3000` | The base URL of the running s33k instance. Trailing slashes are trimmed. |
| `S33K_MCP_ADMIN` | no | `false` | When `true`, registers the full 81-tool admin surface (adds the 12 app-management tools). Unset / not `true` registers the 69-tool customer surface. Set this only for an operator connection, never a customer's. |

The Bearer API key path is whitelisted in s33k's `utils/allowedApiRoutes.ts` for the routes these tools use. Any new authed route a tool calls must be added to that whitelist, or the call is rejected with "This Route cannot be accessed with API."

## Install and build

Run from the `mcp/` directory. Make sure Node 20 is active first.

```bash
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20
cd mcp
npm ci
npm run build
```

This compiles `src/index.ts` to `dist/index.js`.

## Register it in Claude Code

The compiled entry point is `mcp/dist/index.js`. Register it with `claude mcp add`, passing the env vars with `-e`:

```bash
claude mcp add s33k \
  -e S33K_API_KEY=YOUR_S33K_API_KEY \
  -e S33K_BASE_URL=http://localhost:3000 \
  -- node "$(pwd)/dist/index.js"
```

Or add this block to a Claude Code MCP JSON config (for example `.mcp.json` at the repo root, or your user `~/.claude.json` under `mcpServers`). Use the absolute path to the built file:

```json
{
  "mcpServers": {
    "s33k": {
      "command": "node",
      "args": ["/absolute/path/to/s33k/mcp/dist/index.js"],
      "env": {
        "S33K_API_KEY": "YOUR_S33K_API_KEY",
        "S33K_BASE_URL": "http://localhost:3000"
      }
    }
  }
}
```

After registering, restart Claude Code (or reload MCP servers) and the s33k tools become available. Confirm with `claude mcp list`.

## Connect over the hosted HTTP endpoint

A running s33k server exposes the SAME tools over a remote Streamable HTTP MCP endpoint at `/api/mcp`. A recipient connects with one URL plus a Bearer key and NO local install. This is what makes sharing one-click.

The key crux: every tool call the hosted endpoint makes carries ONLY the connecting client's Bearer key, never a server-side or admin key. The s33k API's `authorize()` then enforces that key's scope per connection. So a scoped share key (an `ApiKey` with `scoped_domain` set) connecting over the hosted MCP is automatically held to GET-only, the per-domain allowlist, and its one domain, exactly as a direct REST call would be. A request with no Bearer key is rejected with 401.

**Claude Code:**

```bash
claude mcp add --transport http s33k https://s33k-production.up.railway.app/api/mcp \
  --header "Authorization: Bearer YOUR_S33K_API_KEY"
```

**Claude Code MCP JSON config** (`.mcp.json` or `~/.claude.json` under `mcpServers`):

```json
{
  "mcpServers": {
    "s33k": {
      "type": "http",
      "url": "https://s33k-production.up.railway.app/api/mcp",
      "headers": { "Authorization": "Bearer YOUR_S33K_API_KEY" }
    }
  }
}
```

**Claude.ai connectors / Cursor:** add a custom MCP (HTTP) connector with the URL `https://s33k-production.up.railway.app/api/mcp` and an `Authorization: Bearer YOUR_S33K_API_KEY` header. Any MCP client that speaks Streamable HTTP works the same way.

The endpoint runs stateless: a fresh MCP server, transport, and key-bound fetch are built per request and torn down when the response finishes, so no key or session state is ever shared across connections.

## Run it directly (manual check)

The stdio server waits for a client, so running it by hand will print a startup line to stderr and then block:

```bash
S33K_API_KEY=... S33K_BASE_URL=http://localhost:3000 node dist/index.js
```

A clean boot prints `s33k-mcp connected (base URL: ...). 69 customer tools (set S33K_MCP_ADMIN=true for the full 81-tool admin surface) and 5 resources registered.` to stderr (or, with `S33K_MCP_ADMIN=true`, `81 tools (full admin surface) and 5 resources registered.`). Press Ctrl-C to stop.

## End-to-end smoke test

`smoke-test.mjs` spawns the BUILT server (`dist/index.js`) as a stdio child, drives it with the official MCP client SDK (real `initialize` handshake), and exercises the tools against a live s33k instance. It asserts the registered tool count and that every tool it drives returns a successful, non-empty result.

What it covers:

- **Read tools** run against a real domain (default `getmasset.com`), read-only.
- **Mutating tools** (`create_domain`, `add_keyword`, `update_keyword`, `delete_keyword`) run ONLY against a throwaway domain `s33k-smoke-test.example`, never the real data.
- It is **idempotent and re-runnable**: it deletes the throwaway domain before and after the mutation block via an authenticated `DELETE /api/domains` call (whitelisted for the API key in `utils/verifyUser.ts`), so a second run does not fail on a duplicate-domain error.
- `get_insight` is treated as PASS when Google Search Console is not connected (the tool responded correctly); to exercise its success path, connect GSC for the domain first.

Configuration is read from the runner's environment and never hardcoded:

| Variable | Required | Default | Description |
|---|---|---|---|
| `APIKEY` | yes | none | The s33k global API key. Export it from the root `.env` before running. |
| `S33K_BASE_URL` | no | `http://localhost:3005` | The live s33k API base URL the spawned server should target. |

Build first, then run (Node 20 via nvm). The runner exports the key from the root `.env`:

```bash
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20
npm run build
set -a; . ../.env; set +a    # exports APIKEY (and any S33K_BASE_URL override)
npm run smoke                # or: node smoke-test.mjs
```

Exit code is 0 when every assertion passes, non-zero otherwise. A clean run prints a `Summary: N/N assertions passed.` line with all assertions passing.

## Notes

- All protocol traffic is on stdout. Diagnostic lines (startup, fatal errors) are written to stderr so they do not corrupt the MCP stream.
- Tool errors (for example a missing domain or an unconfigured scraper) are returned as MCP tool error results, not thrown, so the LLM can read and react to them.
