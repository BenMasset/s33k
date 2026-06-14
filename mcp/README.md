# s33k MCP server

This is the MCP (Model Context Protocol) control layer for s33k. It lets an LLM client such as Claude Code or Cursor operate s33k entirely over a single connection: track keywords and read live Google rankings, detect AI visibility from referral and crawler data, read owned analytics, and pull the cross-pillar briefing and scoreboard.

The server is a thin wrapper over the s33k REST API. It speaks stdio transport and authenticates with the s33k Bearer API key, so it runs fully headless with no login cookie.

## Tools

The server registers 20 tools, grouped by pillar. The authoritative source is `src/index.ts`.

### Cross-pillar

| Tool | What it does | Arguments |
|---|---|---|
| `briefing` | One proactive daily standup for a domain: what changed across every pillar and the top three actions. Best first call of the day. | `domain`, `period` (optional, e.g. `30d`) |
| `insights` | Cross-pillar analyst. Joins rank, traffic, AI referrals, and the bot estimate into rules-based findings and prioritized recommendations. | `domain`, `period` (optional) |
| `page_scoreboard` | Joins per-page traffic with tracked keywords and rank. Flags content-gap pages and keywords whose target page got no traffic. | `domain`, `period` (optional) |

### SEO

| Tool | What it does | Arguments |
|---|---|---|
| `discover_pages` | Crawls a domain (sitemap first, then homepage links) and returns up to 25 pages for keyword-to-page mapping. | `domain` |
| `list_keywords` | Lists a domain's keywords with current rank, ranking URL, target page, and last 7 days of rank history. | `domain` |
| `add_keyword` | Adds a keyword to track. Queues a background SERP scrape. | `keyword`, `domain`, `country` (default `US`), `device` (`desktop` or `mobile`, default `desktop`), `target_page` (optional) |
| `update_keyword` | Updates keywords by ID: set target page and/or toggle sticky. | `ids`, `target_page` and/or `sticky` |
| `delete_keyword` | Permanently deletes one or more keywords by ID. | `ids` |
| `refresh_keywords` | Triggers a fresh SERP scrape for specific keyword IDs or a whole domain. | `ids` (array of numbers) OR `domain` |
| `get_insight` | Reads Google Search Console insight (top pages, keywords, countries, stats). Requires GSC connected for that domain. | `domain` |

### AEO

| Tool | What it does | Arguments |
|---|---|---|
| `ai_referrals` | Reports which AI engines send real visitors (per-engine visitors, page views, AI share of referred traffic). | `domain`, `period` (optional) |
| `ai_crawlers` | Reports which AI and search crawlers are crawling a domain (per-bot hits, owners, AI-engine totals, recent sample). | `domain`, `period` (optional) |

### Analytics

| Tool | What it does | Arguments |
|---|---|---|
| `traffic_summary` | Site-wide totals: pageviews, visitors, visits, bounce rate, average duration, pages per visit. | `domain`, `period` (optional) |
| `traffic_breakdown` | Breaks traffic down by a dimension (country, device, browser, os, plus Umami-only region/city/language/screen). | `domain`, `dimension`, `period` (optional) |
| `traffic_timeseries` | Daily (or unit-grouped) time series of pageviews and visitors. | `domain`, `period` (optional), `unit` (optional) |
| `top_events` | Custom/tracked events with their fire counts. | `domain`, `period` (optional) |
| `engagement` | Session-quality engagement tiers (bounced / browsed / engaged) with counts, percentages, and averages. | `domain`, `period` (optional) |
| `human_traffic` | Estimates likely-human vs likely-bot traffic via a bounce/duration heuristic with a known-human referrer floor. An estimate, not an exact count. | `domain`, `period` (optional) |

### Domains

| Tool | What it does | Arguments |
|---|---|---|
| `list_domains` | Lists all domains tracked in s33k. | none |
| `create_domain` | Adds one or more domains to track (bare hostnames, no protocol). | `domains` |

## Requirements

- Node 20 (the s33k repo pins Node 20 via `.nvmrc`; native deps are built for it). The MCP SDK requires Node 18 or newer, so Node 20 is fine.
- A running s33k instance. By default the server talks to `http://localhost:3000`. Set `S33K_BASE_URL` to match how you run s33k (for example `http://localhost:3000` for the local Quickstart, or `http://localhost:8080` for the docker-compose stack).

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `S33K_API_KEY` | yes | none | The value of `APIKEY` in the s33k root `.env` file. |
| `S33K_BASE_URL` | no | `http://localhost:3000` | The base URL of the running s33k instance. Trailing slashes are trimmed. |

The Bearer API key path is whitelisted in s33k's `utils/verifyUser.ts` for the routes these tools use: `GET /api/domains`, `POST /api/domains`, `GET /api/keywords`, `POST /api/keywords`, `PUT /api/keywords`, `DELETE /api/keywords`, `POST /api/refresh`, `GET /api/insight`, `GET /api/insights`, `GET /api/scoreboard`, `GET /api/ai-referrals`, `GET /api/ai-crawlers`, `GET /api/summary`, `GET /api/breakdown`, `GET /api/timeseries`, `GET /api/events`, `GET /api/engagement`, `GET /api/human-traffic`, `GET /api/discover`, and `GET /api/briefing`.

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

## Run it directly (manual check)

The server speaks stdio and waits for a client, so running it by hand will print a startup line to stderr and then block:

```bash
S33K_API_KEY=... S33K_BASE_URL=http://localhost:3000 node dist/index.js
```

A clean boot prints `s33k-mcp connected (base URL: ...). 20 tools registered.` to stderr. Press Ctrl-C to stop.

## End-to-end smoke test

`smoke-test.mjs` spawns the BUILT server (`dist/index.js`) as a stdio child, drives it with the official MCP client SDK (real `initialize` handshake), and exercises all 20 tools against a live s33k instance. It asserts that exactly 20 tools are registered and that every tool returns a successful, non-empty result.

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

Exit code is 0 when every assertion passes, non-zero otherwise. A clean run prints `Summary: 22/22 assertions passed.`

## Notes

- All protocol traffic is on stdout. Diagnostic lines (startup, fatal errors) are written to stderr so they do not corrupt the MCP stream.
- Tool errors (for example a missing domain or an unconfigured scraper) are returned as MCP tool error results, not thrown, so the LLM can read and react to them.
