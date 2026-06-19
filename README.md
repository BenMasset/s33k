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
3. **Analytics.** Read traffic totals, per-page traffic, referrers, geography, devices, browsers, and engagement tiers from your owned Umami instance (Lodd is supported as a legacy provider). s33k also ships its own cookieless, no-PII autocapture script (one tag, zero per-element setup) that records clicks, form submits, scroll depth, engagement time, and first-touch source for conversion attribution.

The product is the unified MCP control plane that joins all three. The per-page scoreboard ties traffic to live rank and flags content gaps (pages with traffic but no tracked keyword) and dead keywords (target pages getting no traffic).

## What you can ask (newer capabilities)

Beyond rank tracking and traffic, s33k now has the higher-level capabilities a marketer actually asks for, all over MCP:

- **Named conversion goals with revenue.** Define goals like "Demo Booked" (a destination page reached or an autocaptured event fired), then ask for the rate, segment it with composable filters (source, landing page, device, country, engagement), and get dollars when a goal carries a value.
- **UTM / campaign attribution.** Group every session by `utm_campaign` (with source/medium splits) and see which campaign converts best.
- **Saved segments.** Name a filter set once ("AI human converters") and re-run it by name instead of re-specifying filters every time.
- **Multi-site portfolio rollup.** Summarize every domain on your account in one call: rank distribution, quick-win count, and human vs AI traffic per site, for the agency / multi-site view.
- **Competitor share of voice.** Tally how often each rival domain ranks for the same terms you track, ranked by share of voice, plus who outranks you per keyword.
- **Core Web Vitals.** Real-user p75 for LCP, CLS, INP, FID, FCP, TTFB scored against Google's field thresholds, with the slowest pages called out.
- **Prebuilt one-call reports.** A weekly digest, an executive summary, a full SEO report, and a full AEO report, each bundling a whole pillar (or all three) into one structured response so you do not chain tools.

## MCP tools

s33k is fully controllable from an LLM over MCP. The server exposes 82 tools and 5 knowledge resources. The authoritative registry is `mcp/src/tools.ts`, shared by the stdio entry and hosted HTTP endpoint. The table below groups the main tools by pillar; `mcp/README.md` and `utils/knowledge.ts` carry the full per-tool descriptions. The example prompts are what you would type into Claude or Cursor; the LLM picks the tool.

### Cross-pillar (start here)

| Tool | What it does | Example prompt |
|---|---|---|
| `start_here` | **Call this first.** The guided entry point: give it a domain (or no domain to pick one) and it returns your setup state, the single most important thing to do now, and where to look next, including which pages AI search lands on (`entry_pages`). If you do not know where to start, start here. | "I just connected s33k. Where do I start?" |
| `briefing` | One proactive daily standup for a domain: a headline, sections, and the top three things to do, across every pillar. The best first call of the day. | "Give me the s33k briefing for getmasset.com." |
| `insights` | The cross-pillar analyst. Joins SEO rank, traffic, AI referrals, and engagement into rules-based findings and prioritized recommendations. | "What does s33k recommend I work on for getmasset.com?" |
| `alerts` | The "what changed and what to do" standup. Compares this period to the prior one and surfaces notable rank moves, traffic swings, and new AI engines as a prioritized list, plus the single top priority. | "What changed on getmasset.com this week and what should I do?" |
| `executive_summary` | The leadership one-glance report: headline numbers, top and top-converting channel, an SEO snapshot, AI visibility, a plain-English health line, and the single most important next action. | "Give me the executive summary for getmasset.com." |
| `weekly_digest` | A week-in-review bundle: traffic, top entry pages, sessions per channel, AI-search sessions, and the keywords that moved most in rank. | "Give me the weekly digest for getmasset.com." |
| `page_scoreboard` | Joins per-page traffic with tracked keywords and rank. Surfaces content-gap pages and keywords whose target page got no traffic. | "Show me the per-page scoreboard for getmasset.com." |
| `entry_pages` | Answers "which pages did AI search land on": analyzes the ENTRY (landing) pages where sessions start, joining each page's first-touch source split (including AI) to its tracked rank, and flags pages that rank but do not land traffic. | "Which pages does AI search land on for getmasset.com?" |
| `entry_page_report` | The entry-page acquisition lens: first-touch sessions per landing page broken down by source channel, with the keywords/rank each page holds, exposing ranking-without-landing and landing-without-ranking gaps. | "Show getmasset.com entry pages with their first-touch source and the keywords each ranks for." |
| `content_performance_report` | Ranks pages by pageviews, joining entries, optional goal conversions, and tracked keywords/rank per page. The cross-pillar content scorecard. | "Which content actually performs on getmasset.com?" |
| `conversion_attribution` | The merged-pillar view only s33k can produce: attributes a goal's conversions and revenue by source (AI vs organic vs direct) and by tracked keyword, and names the money moves. | "What actually drives demo bookings and revenue on getmasset.com, SEO, direct, or AI?" |
| `portfolio_summary` | Summarizes every domain on your account in one call: rank distribution, striking-distance quick-win count, and human plus AI-referral sessions per site. The multi-site / agency view. | "Give me a portfolio rollup of all my sites." |

### SEO (rank tracking and on-page)

| Tool | What it does | Example prompt |
|---|---|---|
| `list_keywords` | Lists a domain's keywords with current Google rank, ranking URL, target page, and recent rank history. | "List the keywords I'm tracking for getmasset.com and their ranks." |
| `add_keyword` | Adds a keyword to track for a domain and queues a background SERP scrape. | "Track 'AI-ready DAM' for getmasset.com, mapped to the /software page." |
| `update_keyword` | Updates keywords by ID: sets the target page and/or toggles the sticky pin. | "Set the target page for keyword 14 to /software." |
| `delete_keyword` | Permanently deletes one or more keywords by ID. | "Delete keywords 14 and 15." |
| `refresh_keywords` | Re-scrapes live Google rankings for specific keyword IDs or a whole domain. | "Refresh all rankings for getmasset.com." |
| `striking_distance` | The highest-ROI to-do list: keywords ranking just off page one (positions 4 to 30), where a small push tends to win, each with its position delta over history. | "What are my striking distance keywords for getmasset.com?" |
| `seo_report` | A prebuilt one-call SEO snapshot: rank distribution, striking-distance quick wins, the biggest movers, and tracked keywords grouped by target page. | "Give me the full SEO report for getmasset.com." |
| `site_audit` | Crawls a domain and returns a prioritized on-page / technical issue list (missing or bad titles, metas, H1s, duplicate titles, thin content), each with a severity. | "Audit getmasset.com for on-page SEO issues." |
| `cannibalization_detection` | Finds keyword cannibalization where two of your own pages compete for the same term and split the equity, with the consolidation work to do. | "Is any content cannibalizing itself on getmasset.com?" |
| `content_gap` | Crawls a named competitor and your site and returns the topics the competitor has pages for that you do not. | "What topics does highspot.com cover that getmasset.com does not?" |
| `competitor_visibility` | Reads the stored SERP for every tracked keyword and tallies competitor share of voice, plus who outranks you per keyword. | "Who are my top competitors in search for getmasset.com?" |
| `discover_pages` | Crawls a domain (sitemap first, then homepage links) and returns up to 25 pages so the LLM can map keywords to real target pages. | "Discover the main pages on getmasset.com so we can map keywords." |
| `get_insight` | Reads Google Search Console insight (top pages, keywords, countries, stats). Requires GSC connected. | "What does Search Console show for getmasset.com this month?" |

### AEO (AI visibility)

| Tool | What it does | Example prompt |
|---|---|---|
| `ai_referrals` | Reports which AI engines are sending real visitors (per-engine visitors and page views, plus the AI share of referred traffic). | "Which AI engines are sending traffic to getmasset.com?" |
| `ai_visibility` | Per-page and per-engine view of AI referrals: which AI engines cite you and on which pages. When referral data is thin it falls back to a deterministic AI-readiness audit. Uses only first-party behavior, never queries an LLM. | "How visible is getmasset.com in AI search, and where is the gap?" |
| `aeo_report` | A prebuilt one-call AEO snapshot: AI referrals per engine plus a per-engine summary. | "Give me the full AEO snapshot for getmasset.com." |

### Analytics (owned traffic, plus autocapture)

| Tool | What it does | Example prompt |
|---|---|---|
| `traffic_summary` | Site-wide totals: pageviews, visitors, visits, bounce rate, average duration, pages per visit. | "How was traffic to getmasset.com over the last 30 days?" |
| `human_traffic` | Estimates how much of a domain's traffic is likely human vs likely bot, using a bounce/duration heuristic with a known-human referrer floor. An estimate, not an exact count. | "How much of getmasset.com traffic is real humans vs bots?" |
| `human_analytics` | Human-only analytics computed from s33k's own first-party pageviews (datacenter bots excluded by IP at ingest), with the exit and bounce rate the Umami view cannot produce. | "Show getmasset.com analytics for humans only, with bounce and exit rate." |
| `channel_report` | Maps every session to a clean marketing channel (Organic Search, AI Search, Referral, Direct) with sessions and share per channel, and conversions per channel when you pass a goal. | "Break getmasset.com traffic down by marketing channel." |
| `campaign_report` | Groups every session by UTM campaign (with utm_source / utm_medium splits) and reports sessions and share per campaign, plus conversions per campaign with a goal. | "Break getmasset.com traffic down by UTM campaign." |
| `live_view` | A polled real-time snapshot of who is on the site right now: active visitors, the pages being viewed, source and country splits, and the most recent events. | "Who is on getmasset.com right now?" |
| `funnel_analysis` | An ordered, multi-step funnel from first-party sessions with per-step drop-off, so you see WHERE people fall out. | "Build a funnel for getmasset.com from /pricing to /cart to checkout." |
| `period_compare` | This period vs the immediately-preceding equal-length period, side by side, with delta and percent change per metric. | "Compare getmasset.com this 30 days vs the previous 30 days." |
| `traffic_breakdown` | Breaks traffic down by a dimension: country, device, browser, os (every provider) or region, city, language, screen (Umami extras). | "Break getmasset.com traffic down by country." |
| `traffic_timeseries` | Daily (or unit-grouped) time series of pageviews and visitors. | "Show me daily pageviews for getmasset.com this month." |
| `top_events` | Custom/tracked events with their fire counts. | "What are the top tracked events on getmasset.com?" |
| `engagement` | Session-quality engagement tiers (bounced / browsed / engaged) with session counts, percentages, and averages. | "How engaged are visitors to getmasset.com?" |

The next six read from s33k's own autocapture event store (one script tag, zero per-element setup, cookieless and no PII). They do not need Umami:

| Tool | What it does | Example prompt |
|---|---|---|
| `top_clicks` | The most-clicked buttons and links by visible text and stable selector, with a per-page breakdown. Records that an element was clicked, never any typed value. | "What gets clicked most on getmasset.com?" |
| `form_submissions` | Which forms get submitted, how often, and from which pages. Records that a form was submitted (its id/name), never field values. | "How many form submissions did getmasset.com get?" |
| `scroll_depth` | How far visitors scroll per page plus a site-wide depth histogram. | "Which getmasset.com pages get read deeply vs abandoned at the top?" |
| `page_engagement` | Active engagement (dwell) time per page, with the timer paused when the tab is hidden or the visitor goes idle, so it is real attention. | "Which getmasset.com pages actually hold attention?" |
| `web_vitals` | Real-user Core Web Vitals (LCP, CLS, INP, FID, FCP, TTFB) at p75 scored against Google's field thresholds, with the slowest pages called out. | "How are getmasset.com's Core Web Vitals, and which pages are slowest?" |
| `conversions_by_source` | Attributes conversions (autocaptured form submits by default) to the first-touch source: direct, organic-search, ai, or referral, with an approximate conversion rate per source. | "Which traffic sources drive conversions on getmasset.com?" |

### Conversion goals and segments

| Tool | What it does | Example prompt |
|---|---|---|
| `create_goal` | Defines a named conversion goal: a destination page reached (`page_reached`) or an autocaptured event fired (`event`, e.g. form_submit). | "Create a goal called Demo Booked when someone reaches /demo/thanks." |
| `list_goals` | Lists the named conversion goals defined for a domain and their match rules. | "What conversion goals are set up for getmasset.com?" |
| `delete_goal` | Deletes a named conversion goal by its id. | "Delete the Newsletter Signup goal." |
| `goal_analytics` | Conversion rate and counts for a goal, filterable and groupable by source, landing page, device, country, or engagement, with revenue when the goal has a value. Human-only by default. | "What is my Demo Booked rate and revenue from organic search?" |
| `suggest_goals` | Proposes ready-to-create goals by spotting a site's likely conversions (thank-you pages, demo / contact / signup pages). | "Suggest conversion goals for getmasset.com." |
| `segment_save` | Saves a named, reusable filter set built from the composable analytics filters (channel, device, country, landing page, page, engagement, humanOnly). | "Save a segment called 'AI human converters' for AI traffic, humans only." |
| `segment_list` | Lists the named segments defined for a domain and the filters each stores. | "What saved segments do I have for getmasset.com?" |
| `segment_delete` | Deletes a named segment by its id. | "Delete the 'Mobile organic' segment." |
| `segment_analytics` | Applies a saved segment by name and returns the human-analytics-style traffic summary with its filters applied. | "Show me the 'AI human converters' segment for getmasset.com." |

### Domains

| Tool | What it does | Example prompt |
|---|---|---|
| `list_domains` | Lists all domains tracked in s33k. | "What domains am I tracking in s33k?" |
| `create_domain` | Adds one or more domains to track (bare hostnames, no protocol). | "Start tracking getmasset.com in s33k." |

### Onboarding and tracking-code setup

| Tool | What it does | Example prompt |
|---|---|---|
| `onboard` | The one-call cold start: creates the domain, discovers and adds candidate keywords with rank scrapes queued, provisions a per-domain analytics website, and returns the tracking snippet plus per-platform install guides. | "Onboard getmasset.com from scratch." |
| `setup_status` | Reports a domain's setup progress as a checklist (site added, keywords tracked, script live, goals defined, first report ready) with the single next step and the exact tool to call. | "Walk me through setting up s33k for getmasset.com." |
| `install_instructions` | Returns the analytics tracking snippet and step-by-step install steps for the user's platform (WordPress, Webflow, Shopify, GTM, Next.js, raw HTML, and more) for an already-onboarded domain. | "How do I add the s33k tracking code on Webflow?" |

### Account, invites, and waitlist (multi-tenant mode)

These manage the invite-only multi-tenant system and are active when `MULTI_TENANT` is on. Write tools require an admin key; read-only member keys are rejected.

| Tool | What it does | Example prompt |
|---|---|---|
| `invite_external` | Sends an external invite that brings a new admin and their own account into s33k (quota-limited). | "Invite jane@company.com to s33k." |
| `invite_internal` | Adds a read-only member seat to your own account for a teammate (unlimited). | "Invite my teammate to view my domains read-only." |
| `list_invites` | Lists every invite you have sent, with status. | "Show me the invites I have sent." |
| `list_waitlist` | Lists waitlist signups so you can decide who to invite (root admin only). | "Who is on the s33k waitlist?" |

### Trust, data ownership, and self-support

| Tool | What it does | Example prompt |
|---|---|---|
| `security_facts` | Returns s33k's complete, source-cited trust facts: no model training, tenant isolation, encryption at rest, data ownership, and cookieless/no-PII tracking. | "Is s33k safe? Does it train on my data?" |
| `export_data` | Downloads everything s33k holds about your account as one JSON bundle. Never includes a secret. | "Export all of my s33k data." |
| `delete_account_data` | Permanently and irreversibly deletes your entire account and all of its data. Requires the exact confirmation string. | "Delete my s33k account and all its data." |
| `help` | Answers any question about s33k from its single authoritative product-knowledge layer. Reads no account data and never queries an LLM. | "What does ai_visibility do?" |
| `request_feature` | Submits a request for a capability s33k does not have, after confirming via `help` that it is genuinely missing. | "Request CSV export of keyword rank history." |
| `list_feature_requests` | Lists submitted feature requests (root admin only). | "Show me the feature requests people have submitted." |

### Knowledge resources

Five read-only MCP resources expose the same product-knowledge layer the `help` tool reads, so a client can pull a whole doc into context with `resources/read`: `knowledge://capabilities`, `knowledge://setup`, `knowledge://reasoning`, `knowledge://troubleshooting`, and `knowledge://trust`.

## What V1 is and is not

V1 is honest about its scope. It is a working, installable product, not a finished SaaS.

- There is **no web dashboard for the s33k features in V1**. You drive everything from your LLM over MCP. The forked SerpBear web UI still exists for logging in and pasting your scraper key, but the SEO, AEO, and analytics features are MCP-first by design.
- s33k stores its own data in **Postgres in production and SQLite locally**, selected automatically by whether `DATABASE_URL` is set. The analytics data lives in whatever provider you point it at (your own Umami, or Lodd as a legacy option), and the autocapture event store lives in s33k's own database.
- **AI-referral (AEO) detection reads real referral data.** It does not call any LLM to guess at citations, and it cannot show AI visibility until your site actually starts getting AI referrals.
- **Single admin account by default.** The invite-only multi-tenant mode (invites, read-only members, waitlist) is flag-gated behind `MULTI_TENANT` and off by default. With the flag off, behavior is byte-for-byte single-tenant. It is documented in `MULTI_TENANT.md`.
- **No server-side LLM, ever.** The AI features (briefing, insights, ai_visibility, alerts, entry_pages) are rules-based: they compute structured findings on your data and hand them to your own LLM to narrate. s33k makes no model-provider calls and has no model-training path. Your data is never used to train any model. See `SECURITY.md`.

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

For deploying s33k somewhere your LLM and your team can reach it (a server or VPS), with the full owned analytics stack, run it on Postgres in production (s33k selects Postgres automatically when `DATABASE_URL` is set, SQLite otherwise). The current operator checklist and env-var reference is [`DEPLOYMENT_READINESS.md`](DEPLOYMENT_READINESS.md), and [`CLAUDE.md`](CLAUDE.md) section A is the source of truth for the database choice and deploy mechanism. [`DEPLOY.md`](DEPLOY.md) is the long-form Railway recipe (note: its SQLite-on-volume sections are historical, superseded by `CLAUDE.md` section A).

## Security and trust

s33k is cookieless, captures no PII, never trains on your data, and makes no server-side LLM calls. Every trust claim points at the exact code or test that proves it: see [`SECURITY.md`](SECURITY.md), or ask your own LLM via the `security_facts` MCP tool.

## Repo orientation for contributors

[`CLAUDE.md`](CLAUDE.md) is the door-sign for anyone (human or AI) working in the repo: runtime and commands, the hard-won deploy gotchas, the multi-tenant scoping seam, and the no-server-side-LLM invariant.

## Analytics parity with Lodd

s33k collects and exposes at least every datapoint that the Lodd analytics SaaS does, and beats it (per-page traffic joined to live rank and content-gap detection, provider-independent AI-referral detection, four extra Umami-only breakdown dimensions plus a true daily time series, and the full MCP control surface). The complete datapoint-by-datapoint mapping with live sample values is in [`PARITY.md`](PARITY.md).

## License

MIT, inherited from SerpBear. See [`LICENSE`](LICENSE).
