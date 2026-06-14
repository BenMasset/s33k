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

s33k is fully controllable from an LLM over MCP. The server exposes 19 tools (authoritative list from `mcp/src/index.ts`):

| Tool | What it does |
|---|---|
| `list_domains` | List all domains tracked in s33k. |
| `create_domain` | Add one or more domains to track (bare hostnames, no protocol). |
| `discover_pages` | Crawl a domain (sitemap first, then homepage links) and return a compact summary of up to 25 pages so the LLM can map keywords to real target pages in one shot. The onboarding fast path. |
| `list_keywords` | List a domain's keywords with current Google rank, ranking URL, target page, and last 7 days of rank history. |
| `add_keyword` | Add a keyword to track for a domain. Queues a background SERP scrape. |
| `update_keyword` | Update keywords by ID: set the target page and/or toggle sticky. |
| `delete_keyword` | Permanently delete one or more keywords by ID. |
| `refresh_keywords` | Trigger a fresh SERP scrape for specific keyword IDs or for a whole domain. |
| `get_insight` | Read Google Search Console insight for a domain (top pages, keywords, countries, stats). Requires GSC connected. |
| `page_scoreboard` | Join per-page traffic with tracked keywords and rank. Surfaces content-gap pages and keywords whose target page got no traffic. |
| `ai_referrals` | Report which AI engines are sending real visitors (per-engine visitors and page views, plus the AI share of referred traffic). |
| `ai_crawlers` | Report which AI answer-engine and search crawlers (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Bingbot, etc.) are crawling a domain. The leading indicator of AEO: AI bots crawl a site before they cite it. Per-bot hits and owners, AI-engine totals, and a recent sample. |
| `traffic_summary` | Site-wide totals: pageviews, visitors, visits, bounce rate, average duration, pages per visit. |
| `traffic_breakdown` | Break traffic down by a dimension: country, device, browser, os (every provider) or region, city, language, screen (Umami extras). |
| `traffic_timeseries` | Daily (or unit-grouped) time series of pageviews and visitors. |
| `top_events` | Custom/tracked events with their fire counts. |
| `engagement` | Session-quality engagement tiers (bounced / browsed / engaged) with session counts, percentages, and averages. |
| `human_traffic` | Estimate how much of a domain's traffic is likely humans vs likely bots, using a bounce/duration behavior heuristic with a known-human referrer floor. Returns estimated human, bot, and total visitors plus the bot share. An estimate, not an exact per-session count. |
| `insights` | The cross-pillar analyst. Joins SEO rank, analytics traffic, AI referrals, and the bot estimate into rules-based findings and prioritized recommendations for your LLM to narrate. Surfaces content gaps, rank/traffic mismatches, AEO proof, traffic concentration, and a bot-share caveat. |

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

Register it with `claude mcp add`, pointing `S33K_API_KEY` at the `APIKEY` from your `.env` and `S33K_BASE_URL` at your running instance:

```bash
claude mcp add s33k \
  -e S33K_API_KEY=YOUR_S33K_API_KEY \
  -e S33K_BASE_URL=http://localhost:8080 \
  -- node /Users/ben/Projects/s33k/mcp/dist/index.js
```

After registering, restart Claude Code (or reload MCP servers) and the s33k tools become available. Confirm with `claude mcp list`. Full MCP details are in [`mcp/README.md`](mcp/README.md).

## Analytics parity with Lodd

s33k collects and exposes at least every datapoint that the Lodd analytics SaaS does, and beats it (per-page traffic joined to live rank and content-gap detection, provider-independent AI-referral detection, five extra Umami-only dimensions, and the full MCP control surface). The complete datapoint-by-datapoint mapping with live sample values is in [`PARITY.md`](PARITY.md).

## License

MIT, inherited from SerpBear. See [`LICENSE`](LICENSE).
