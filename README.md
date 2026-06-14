# s33k

s33k is an open, self-hosted tool that a marketer controls entirely from their LLM over MCP. It joins the three things a marketing team checks constantly into one control plane:

- **SEO**: where every page ranks in Google for its target keywords.
- **AEO**: which AI engines (ChatGPT, Claude, Perplexity, Gemini, Copilot) actually mention and send visitors to the brand, measured from real referral data.
- **Analytics**: page traffic, sources, and engagement, served from an analytics engine you own.

The thesis: you run the whole product from your own LLM over the Model Context Protocol. No UI is required for V1. And it runs on a stack you own (s33k + Umami + Postgres), so your data never leaves your control.

s33k is a fork of [`towfiqi/serpbear`](https://github.com/towfiqi/serpbear) (MIT). It keeps SerpBear's rank-tracking core and adds the analytics join, the AI-referral (AEO) layer, the per-page scoreboard, and the MCP control plane.

## The three pillars

1. **SEO.** Track unlimited keywords per domain, each mapped to its target page, and scrape live Google rankings (Serper is the day-one source; one key, results in about two minutes).
2. **AEO.** Detect which AI answer engines are citing you by classifying referral traffic. You see per-engine visitors and the AI share of referred traffic, with no need to query any LLM.
3. **Analytics.** Read traffic totals, per-page traffic, referrers, geography, devices, browsers, and engagement tiers from your owned Umami instance (Lodd is supported as a legacy provider).

The product is the unified MCP control plane that joins all three. The per-page scoreboard ties traffic to live rank and flags content gaps (pages with traffic but no tracked keyword) and dead keywords (target pages getting no traffic).

## MCP tools

s33k is fully controllable from an LLM over MCP. The server exposes 20 tools (authoritative list from `mcp/src/index.ts`), grouped below by pillar with one example prompt each. The example prompts are what you would type into Claude or Cursor; the LLM picks the tool.

### Start here (cross-pillar)

| Tool | What it does | Example prompt |
|---|---|---|
| `briefing` | One proactive daily standup for a domain: what changed across every pillar and the top three things to do about it. The best first call of the day. | "Give me the s33k briefing for getmasset.com." |
| `insights` | The cross-pillar analyst. Joins SEO rank, traffic, AI referrals, and the bot estimate into rules-based findings and prioritized recommendations. | "What does s33k recommend I work on for getmasset.com?" |
| `page_scoreboard` | Joins per-page traffic with tracked keywords and rank. Surfaces content-gap pages and keywords whose target page got no traffic. | "Show me the per-page scoreboard for getmasset.com." |

### SEO (rank tracking)

| Tool | What it does | Example prompt |
|---|---|---|
| `discover_pages` | Crawls a domain (sitemap first, then homepage links) and returns up to 25 pages so the LLM can map keywords to real target pages in one shot. The onboarding fast path. | "Discover the main pages on getmasset.com so we can map keywords." |
| `list_keywords` | Lists a domain's keywords with current Google rank, ranking URL, target page, and the last seven days of rank history. | "List the keywords I'm tracking for getmasset.com and their ranks." |
| `add_keyword` | Adds a keyword to track for a domain and queues a background SERP scrape. | "Track 'AI-ready DAM' for getmasset.com, mapped to the /software page." |
| `update_keyword` | Updates keywords by ID: sets the target page and/or toggles sticky. | "Set the target page for keyword 14 to /software." |
| `delete_keyword` | Permanently deletes one or more keywords by ID. | "Delete keywords 14 and 15." |
| `refresh_keywords` | Triggers a fresh SERP scrape for specific keyword IDs or a whole domain. | "Refresh all rankings for getmasset.com." |
| `get_insight` | Reads Google Search Console insight (top pages, keywords, countries, stats). Requires GSC connected. | "What does Search Console show for getmasset.com this month?" |

### AEO (AI visibility)

| Tool | What it does | Example prompt |
|---|---|---|
| `ai_referrals` | Reports which AI engines are sending real visitors (per-engine visitors and page views, plus the AI share of referred traffic). | "Which AI engines are sending traffic to getmasset.com?" |
| `ai_crawlers` | Reports which AI and search crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bingbot, etc.) are crawling a domain. The leading indicator of AEO: AI bots crawl a site before they cite it. | "Are any AI crawlers hitting getmasset.com yet?" |

### Analytics (owned traffic)

| Tool | What it does | Example prompt |
|---|---|---|
| `traffic_summary` | Site-wide totals: pageviews, visitors, visits, bounce rate, average duration, pages per visit. | "How was traffic to getmasset.com over the last 30 days?" |
| `traffic_breakdown` | Breaks traffic down by a dimension: country, device, browser, os (every provider) or region, city, language, screen (Umami extras). | "Break getmasset.com traffic down by country." |
| `traffic_timeseries` | Daily (or unit-grouped) time series of pageviews and visitors. | "Show me daily pageviews for getmasset.com this month." |
| `top_events` | Custom/tracked events with their fire counts. | "What are the top tracked events on getmasset.com?" |
| `engagement` | Session-quality engagement tiers (bounced / browsed / engaged) with session counts, percentages, and averages. | "How engaged are visitors to getmasset.com?" |
| `human_traffic` | Estimates how much of a domain's traffic is likely human vs likely bot, using a bounce/duration heuristic with a known-human referrer floor. An estimate, not an exact per-session count. | "How much of getmasset.com traffic is real humans vs bots?" |

### Domains

| Tool | What it does | Example prompt |
|---|---|---|
| `list_domains` | Lists all domains tracked in s33k. | "What domains am I tracking in s33k?" |
| `create_domain` | Adds one or more domains to track (bare hostnames, no protocol). | "Start tracking getmasset.com in s33k." |

## AI crawler detection (the flagship AEO signal)

AI answer engines crawl a site before they ever cite it or send a visitor, so the crawl is the earliest AEO signal s33k can surface. The detection engine lives entirely inside s33k:

- `utils/ai-crawlers.ts` classifies a raw `User-Agent` into `{ isCrawler, bot, owner, isAiEngine }` against an editable list of known bots (OpenAI GPTBot / OAI-SearchBot / ChatGPT-User, Anthropic ClaudeBot / Claude-Web / Claude-User / anthropic-ai, PerplexityBot / Perplexity-User, Google-Extended, Googlebot, Applebot-Extended, Bingbot / BingPreview, Amazonbot, Bytespider, CCBot, Meta-ExternalAgent / FacebookBot, DuckAssistBot, cohere-ai, YouBot, Diffbot, ImagesiftBot). The function never throws.
- `POST /api/crawler-hit` with `{ domain, path, userAgent }` (Bearer-key auth) classifies the UA and records a row in the `crawler_hit` table only when it is a recognized crawler. Normal browser traffic is classified and echoed back, but never stored.
- `GET /api/ai-crawlers?domain=&period=` returns the per-bot breakdown (bot, owner, isAiEngine, hits, lastSeen, sorted by hits), totals (aiEngineHits, allCrawlerHits), and a recent sample.
- The `ai_crawlers` MCP tool exposes the report to your LLM.

### Production feed (follow-up, touches the live site, not done here)

The engine above is fully self-contained; it just needs to be fed real crawler hits from the production site. The follow-up is a tiny shipper on getmasset.com (or any tracked site) that, for each inbound request, POSTs `{ domain, path, userAgent }` to this instance's `/api/crawler-hit` with the Bearer API key. Two ways to do it:

- **Edge/middleware (real-time):** in the site's Next.js `middleware.ts` (or a Vercel Edge Function / Cloudflare Worker), fire-and-forget a `fetch` to `/api/crawler-hit` on every request. Keep it non-blocking so it never adds latency, and only forward the UA, path, and host (no PII, no cookies).
- **Log shipper (batch):** a small cron/worker that tails the web server or CDN access logs and POSTs one hit per request line.

Either way the classifier runs s33k-side, so the shipper stays dumb (it forwards every UA and lets `/api/crawler-hit` decide what to keep). This change lives in the production site repo and was intentionally left out of this branch.

## What V1 is and is not

V1 is honest about its scope. It is a working, installable product, not a finished SaaS.

- There is **no web dashboard for the s33k features in V1**. You drive everything from your LLM over MCP. The forked SerpBear web UI still exists for logging in and pasting your scraper key, but the SEO, AEO, and analytics features are MCP-first by design.
- s33k stores its own data in **sqlite**. The analytics data lives in whatever provider you point it at (your own Umami, or Lodd as a legacy option).
- **AI-referral (AEO) detection reads real referral and crawler data.** It does not call any LLM to guess at citations, and it cannot show AI visibility until your site actually starts getting AI referrals or crawler hits.
- The **AI-crawler feed needs a small shipper on your production site** to POST crawler hits to s33k. The detection engine is built and shipped here; wiring it into a live site is a follow-up that lives in your site's repo, not this one. See the AI crawler detection section above.
- Single admin account. The experimental multi-tenant mode (`MULTI_TENANT`) is documented in `MULTI_TENANT.md` but is not the default path.

## Quickstart (local, from source)

This is the fastest way for a friend to clone s33k and run it on their own machine. It runs the s33k app and the MCP server against a local sqlite database. For analytics you can point at an existing Umami or Lodd instance, or run the full owned stack with docker-compose (next section).

```bash
# 1. Clone and enter the repo.
git clone https://github.com/BenMasset/s33k.git
cd s33k

# 2. Use Node 20 (the repo pins it via .nvmrc).
nvm use 20   # or: nvm install 20 && nvm use 20

# 3. Install dependencies.
npm ci

# 4. Create your env file and fill it in.
cp .env.example .env
#    Then edit .env:
#    - set USER_NAME and PASSWORD
#    - regenerate SECRET:  openssl rand -hex 34
#    - regenerate APIKEY:  openssl rand -hex 24
#    - paste your Serper key into SERPER_API_KEY (get one at https://serper.dev)
#    - set the UMAMI_* or LODD_* analytics block (or leave analytics for later)

# 5. Run the app.
npm run dev
```

s33k is now at http://localhost:3000 (set `NEXT_PUBLIC_APP_URL` and the `PORT` to match if you run it on a different port). Log in with the `USER_NAME` and `PASSWORD` from your `.env`. The scraper key can also be set in the UI (Settings, choose Serper), where it is stored encrypted in the database.

Then build and register the MCP server so your LLM can drive s33k (see the "Connect the MCP server" section below for the full block):

```bash
cd mcp && npm ci && npm run build && cd ..
claude mcp add s33k \
  -e S33K_API_KEY="$(grep '^APIKEY=' .env | cut -d= -f2)" \
  -e S33K_BASE_URL=http://localhost:3000 \
  -- node "$(pwd)/mcp/dist/index.js"
```

Restart your LLM client, then try: "Give me the s33k briefing for example.com."

## Run it with docker-compose

The `deploy/` folder ships the full owned stack in one compose file: the s33k app (built from this repo), a self-hosted Umami instance, and an official PostgreSQL for Umami. s33k keeps its own sqlite on a named volume.

```bash
# 1. Copy the env template and edit it (regenerate SECRET and APIKEY).
cp deploy/.env.template deploy/.env

# 2. Bring up the whole stack.
docker compose -f deploy/docker-compose.yml up -d --build
```

`deploy/.env.template` documents every variable, grouped and commented. The two you must regenerate before any real use are `SECRET` and `APIKEY`:

```bash
openssl rand -hex 34   # SECRET
openssl rand -hex 24   # APIKEY
```

### Default login and ports

| Service | URL | Login |
|---|---|---|
| s33k | http://localhost:8080 | `admin` / the `PASSWORD` you set in `deploy/.env` |
| Umami | http://localhost:8081 | `admin` / `umami` (change in the Umami UI) |

First-run steps inside s33k:

1. Log in at http://localhost:8080.
2. Go to Settings, select the **Serper** scraper, and paste your [Serper](https://serper.dev) key. (The scraper key is stored encrypted in s33k's database, not in env.)
3. Create a website in Umami (http://localhost:8081), add its tracking script to your site, and set `UMAMI_WEBSITE_ID` in `deploy/.env` (or let s33k match by domain).
4. Add your domain and keywords, each mapped to its target page.

Internally, s33k reaches Umami at `http://umami:3000` over the compose network. The host ports 8080 and 8081 are only for your browser.

## Connect the MCP server in Claude Code

The MCP server lives in `mcp/`. Build it once, then register it. Make sure Node 20 is active first.

```bash
cd mcp
npm install
npm run build
```

Register it with `claude mcp add`, pointing `S33K_API_KEY` at the `APIKEY` from your `.env` and `S33K_BASE_URL` at your running instance. Set the base URL to match how you run s33k: `http://localhost:3000` for the local Quickstart, or `http://localhost:8080` for the docker-compose stack.

```bash
claude mcp add s33k \
  -e S33K_API_KEY=YOUR_S33K_API_KEY \
  -e S33K_BASE_URL=http://localhost:3000 \
  -- node "$(pwd)/mcp/dist/index.js"
```

To connect a different client (Cursor, or Claude Code via a JSON config), add this block to your client's MCP config under `mcpServers`. Use the absolute path to the built entry point and your real key:

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

After registering, restart your LLM client (or reload MCP servers) and the s33k tools become available. Confirm with `claude mcp list`. Full MCP details are in [`mcp/README.md`](mcp/README.md).

## Hosting

For deploying s33k somewhere your LLM and your team can reach it (a server or VPS), with the full owned analytics stack, see [`DEPLOY.md`](DEPLOY.md).

## Analytics parity with Lodd

s33k collects and exposes at least every datapoint that the Lodd analytics SaaS does, and beats it (per-page traffic joined to live rank and content-gap detection, provider-independent AI-referral detection, five extra Umami-only dimensions, and the full MCP control surface). The complete datapoint-by-datapoint mapping with live sample values is in [`PARITY.md`](PARITY.md).

## License

MIT, inherited from SerpBear. See [`LICENSE`](LICENSE).
