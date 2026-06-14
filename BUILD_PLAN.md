# s33k: Build Plan

**What s33k is:** one open, self-hosted tool that a marketer controls entirely from their LLM over MCP, combining three things they check constantly:
- **SEO:** where every page ranks in Google for its target keywords (SerpBear core).
- **Analytics:** page traffic and sources (start by reading Lodd's API; later replace Lodd with self-hosted Umami).
- **AEO:** whether ChatGPT, Claude, Perplexity, and Gemini mention and cite the brand vs competitors (built natively on top of the LLM connection).

The product is the **unified MCP control plane** that joins all three. Forked from `towfiqi/serpbear` (MIT). Domain: s33k.io.

**Documented up front:** the AI assistant assessed this as a multi-week product and recommended a scoped proof of concept; Ben overruled it and committed to a rough, installable V1 inside Fork Week. This plan is how we try.

---

## Guiding principle: 5 minutes to value

A friend should get from install to seeing real data in about five minutes. This is the bar every onboarding decision is measured against. Implication for data sources:
- **Serper is the day-one value path.** One API key, paste it, add keywords, see live rankings in ~2 minutes. This is what onboarding leads with.
- **Google Search Console is the richer opt-in layer, not the first step.** SerpBear's GSC connection is a service-account flow (create a Google Cloud project, service account, download a JSON key, paste client_email + private_key, add as a user in GSC): a 15-30 minute slog that breaks the 5-minute promise. So GSC is "level 2," connected after first value.
- **Build a one-click "Connect Google Search Console" OAuth** to replace the slog. SerpBear lacks this; it is a real differentiator and a strong upstream PR. Self-hosted wrinkle (OAuth redirect URIs) solved with a device-code flow or a small hosted auth broker. Roadmap item, not day one.

## Phase 0: Foundation (Day 3)
- [x] Fork SerpBear to `BenMasset/s33k`, name it, register s33k.io
- [x] Create local `.env`, boot locally (Node 20 pinned; runs on port 3005)
- [x] Install deps and boot s33k locally (login works: admin / local placeholder)
- [x] Wire **Serper** as the SERP source (Ben added his key; verified working)
- [x] Add the starter keyword set, each mapped to its target page (target page parked in the `tags` field until Phase 1)
- [x] First live Google rankings on the board (getmasset.com: "masset" #1, "Seismic alternative" #38, the other 5 are opportunity gaps not yet in top 100). Scrape ran in ~11s.
- [ ] (Optional, level 2) Connect Google Search Console for real impression data

## Phase 1: Per-page mapping (Day 4). DONE
- [x] Add a `target_page` field to keywords (model + migration + API + types + parseKeywords). Existing keywords backfilled from tags.
- [x] Show target page in the keyword list (Target Page column) and an optional Target Page input in the Add-Keyword form. (Full per-page grouping view can come later; the column is in.)

## Phase 1.5: Kill the GSC friction (the 5-min-to-value differentiator)
- [ ] Replace the GSC service-account paste with a one-click "Connect Google Search Console" OAuth button
- [ ] Handle the self-hosted redirect-URI problem (device-code flow or a small hosted auth broker)
- [ ] Shape it as an upstream pull request to SerpBear

## Phase 2: The MCP control layer (Day 5, the headline). DONE
- [x] Built an MCP server (`mcp/`) over s33k's REST API. Verified returning live data over the MCP protocol.
- [x] **MCP completeness: the whole product is now controllable from MCP with no UI (V1 surface).** 20 tools registered and verified over stdio (`tools/list` + live `tools/call`):
  - SEO/control: list_domains, create_domain, list_keywords, add_keyword, update_keyword, delete_keyword, refresh_keywords, get_insight.
  - Onboarding: discover_pages (crawl a domain, return the live page list so keywords map to real pages in one shot).
  - Analytics (full Lodd parity + extras): page_scoreboard, ai_referrals, traffic_summary, traffic_breakdown, traffic_timeseries, top_events, engagement.
  - 10x signals (beyond commodity analytics): ai_crawlers (answer-engine bot detection), human_traffic (bot-vs-human filtering), insights (cross-pillar SEO + analytics + AEO findings).
  - Proactive analyst: briefing (a single cross-pillar daily standup, see the Daily Briefing section below).
- [x] verifyUser whitelist extended so every headless tool works with the Bearer API key (added PUT/DELETE keywords + the 5 new analytics GET routes). README has the Claude Code connect command. (Ben runs `claude mcp add` to wire it in.)
- [ ] Stretch: shape the MCP server as the upstream pull request to SerpBear
- [ ] Follow-up: `get_insight` needs Search Console connected (Phase 1.5), not yet wired

## Phase 3: Analytics join (Day 6). DONE (API + MCP; UI pending)
- [x] Pull page traffic from Lodd's API (utils/lodd.ts, env-driven, getmasset.com site)
- [x] Join per page: traffic + target keywords + live rank, via GET /api/scoreboard and the MCP tool page_scoreboard. Also surfaces content-gap pages (traffic, no keyword) and unmatched keywords.
- [x] A visible Scoreboard view in the UI (new "Scoreboard" tab on the domain page; UTM variants aggregated, rank 0 shown as "Not ranked", content-gap and no-traffic sections)
- [ ] Minor: aggregate UTM URL variants by clean path (so "/" and "/?utm_medium=redirect" merge); display rank 0 as "not ranked"

### Analytics parity with Lodd: DONE (zero gaps; provider + API + MCP)
- [x] s33k now collects and exposes AT LEAST every Lodd datapoint, and beats it. Full mapping, live sample values, and the conclusion are in `PARITY.md`.
- [x] Provider interface (`utils/analytics.ts`) extended with `getSummary`, `getBreakdown`, `getTimeSeries`, `getEvents`, `getEngagement`; implemented in both `utils/lodd.ts` and `utils/umami.ts`; graceful "not configured" provider covers all of them.
- [x] Lodd parity (verified live, real getmasset.com): totals, per-page, referrers+utm, ai-sources, countries, devices, browsers, operating-systems, session-scores/engagement, events. **Zero GAPs.**
- [x] Extras beyond Lodd (Umami-only): region, city, language, screen, daily time series. On the Lodd provider these correctly report "Not supported by Lodd"; on Umami they return real rows.
- [x] New REST routes (Bearer-key reachable): /api/summary, /api/breakdown, /api/timeseries, /api/events, /api/engagement. New MCP tools: traffic_summary, traffic_breakdown, traffic_timeseries, top_events, engagement.

## Phase 4: AEO = AI referral tracking from analytics (no LLM queries). DONE
- [x] AEO is measured from real analytics REFERRAL data, not by querying any LLM. `getReferralSources` + `classifyReferrer` (utils/ai-sources.ts) detect which AI engines (ChatGPT, Claude, Perplexity, Gemini, Copilot, etc.) actually send visitors.
- [x] Surfaced via GET /api/ai-referrals and the MCP tool `ai_referrals`: per-engine visitors/pageviews plus totals (AI visitors, all referred visitors, AI share of referred traffic). Live: ChatGPT 2, Claude 1, 6% AI share.
- [x] Per-page AI-referral attribution joined into the scoreboard: the scoreboard now attributes AI-referral visitors to their landing pages (with graceful `referralError` / `aiReferralVisitors: 0` degradation if the referral fetch fails, never a 500).

## Phase 6: Auto-discovery onboarding. DONE
The 5-minute-to-value bar applied to setup: a new user should not have to hand-type their page list. The `discover_pages` MCP tool (and `GET /api/discover`) crawls a supplied domain, follows same-origin links, and returns the live page list so the LLM can map keywords to real target pages in one shot.
- [x] `utils/site-crawl.ts`: same-origin BFS crawler that returns the discovered page set. Hardened against SSRF (see below).
- [x] `GET /api/discover?domain=...`: Bearer-key reachable (whitelisted in `utils/verifyUser.ts`), GET-only, validates `domain`, strips query strings.
- [x] MCP tool `discover_pages`: surfaces the crawl to the LLM so onboarding is "point at your domain, I will find your pages" instead of manual entry. Live verified: getmasset.com returns 25 pages.
- [x] **SSRF hardening** (the hosted-product requirement): `isPublicHostname()` rejects non-http(s) schemes plus loopback / RFC1918 / link-local / CGNAT / IPv6-private literals and `localhost`/`.local` names before any network call. This matters because s33k is becoming a multi-tenant hosted product where untrusted tenants hold API keys, and the `169.254.169.254` cloud-metadata endpoint is the classic credential-theft vector. Live verified: getmasset.com returns 25 pages; `localhost`, `127.0.0.1:3005`, and `169.254.169.254` return 0 pages with a graceful error and leak no internal content. Residual: `redirect: 'follow'` could 302 to an internal host; documented in-code as a network-egress-layer concern (closing it fully would risk breaking legitimate apex->www redirects).

## Phase 5: Ship V1 (Day 7). DONE (install package)
- [x] Package so a friend can install: `deploy/docker-compose.yml` (s33k + Umami + Postgres in one stack) and `deploy/.env.template` (placeholders and throwaways only, with openssl regenerate instructions; zero real secrets). README rewritten with the three-pillar story, install steps, and the full 20-tool MCP table.
- [ ] Open the MCP pull request upstream
- [ ] Decide the model: free lead-gen for Masset, paid, or open-core (log in roadmap)

## Deploy readiness: a documented, secured 10-minute Railway deploy. DONE
The gap was that a fresh container started with an empty DB, no scraper key, and the public SerpBear demo credentials, so a naive deploy was both broken and unsafe. Closed three ways:
- [x] **Production credential guard.** `entrypoint.sh` refuses to boot when `NODE_ENV=production` and `APIKEY`, `SECRET`, or `PASSWORD` are unset, left as a `REGENERATE_ME` placeholder, or set to the public SerpBear demo values. A second guard in `pages/api/login.ts` blocks login under the same conditions (defends the case where `node server.js` is run directly, bypassing the entrypoint). Both guards gate on `NODE_ENV === 'production'`, so local dev with the demo defaults is byte-for-byte unchanged. The guard uses an explicit `exit 1`; `set -e` was deliberately NOT added, so a migration that fails (or is already applied) still boots the app exactly as before.
- [x] **Env-configured SERP scraper.** `getAppSettings` (in `pages/api/settings.ts`, mirrored in `cron.js`) now falls back to `SERPER_API_KEY` (or `SCAPING_API`) for the key and `SCRAPER_TYPE` for the backend when none is set in the Settings UI. A DB-stored value always wins, so existing UI-configured instances are unchanged; a fresh hosted deploy gets a working scraper from env with no UI step. Verified in isolation: DB value wins, env only fills an empty key, `SCRAPER_TYPE` only fills the default `'none'`. Test: `__tests__/pages/settings-serp-env-fallback.test.ts`.
- [x] **`DEPLOY.md`: the copy-pasteable Railway recipe.** Generate strong secrets (openssl), create the service from the Dockerfile, mount a persistent volume at `/app/data` (the one un-skippable step, since the Dockerfile `rm -rf data` means no volume = data wiped every redeploy), set env (auth, public URL, Serper, Umami pointing at the existing Railway instance), a security checklist, and post-boot keyword-seeding curl commands. Zero real secrets in the file (only `REPLACE_*` placeholders). Tests for the guards: `__tests__/pages/login-demo-credentials.test.ts`.

## Daily Briefing: the proactive analyst (20th MCP tool). DONE
The "tell me what to DO, not just what happened" capability, and the recommended FIRST call each day.
- [x] **`GET /api/briefing?domain=...&period=...`** (Bearer-key reachable, whitelisted in `utils/verifyUser.ts`, GET-only). RULES-BASED, no LLM call: it pulls every s33k pillar once (traffic, human-vs-bot, SEO rank + opportunity pages, AI referrals, AI crawlers, engagement), runs small transparent commented rules over the joined data, and returns a narration-ready `{ headline, sections[], recommendations[], generatedFor }`. The user's LLM narrates it as a morning standup; the server does the joins and prioritization.
- [x] **Never 500s on a sub-signal failure.** Each pillar is fetched independently and its error is swallowed into a per-section note, so a dead provider or empty table degrades one section, not the whole briefing. The only 4xx paths are auth (401) and missing domain (400). Test: `__tests__/pages/briefing-degradation.test.ts`.
- [x] **MCP tool `briefing`.** Surfaces the briefing to the LLM with a description that tells it to lead with the headline and recommendations. Live verified on real getmasset.com data: correctly reports ~58% bot share (plan against the human figure), the `/resources/claude-artifacts-for-marketers` opportunity page (real traffic, no tracked keyword), Claude + ChatGPT AI referrals, and a 97% bounce caveat, with three prioritized recommendations.

## The 10x: AI-native signals beyond commodity analytics. DONE
The differentiator over Lodd/Plausible is being the AI-native analyst across the joined pillars, plus signals dashboards do not capture. Three shipped, each MCP-controllable and Bearer-reachable over REST:
- [x] **AI-crawler detection** (`utils/ai-crawlers.ts`, `pages/api/ai-crawlers.ts`, `database/models/crawlerHit.ts` + migration, MCP `ai_crawlers`). Classifies answer-engine bot user-agents (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, anthropic-ai, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Googlebot, Applebot-Extended, Bingbot, Amazonbot, Bytespider, CCBot, Meta-ExternalAgent/FacebookBot, DuckAssistBot, cohere-ai, YouBot, Diffbot, ImagesiftBot) to a normalized owner (OpenAI, Anthropic, Perplexity, Google, Apple, Microsoft, Amazon, Meta, etc.) and an is-answer-engine flag. `POST /api/crawler-hit` ingests a hit; `GET /api/ai-crawlers` reports who crawled. Answers "are the AI engines actually reading my site," which no rank tracker shows.
- [x] **Human-vs-bot traffic filtering** (`utils/bot-filter.ts`, `pages/api/human-traffic.ts`, MCP `human_traffic`). Ports the working heuristic from `lodd-traffic/traffic.py`: a segment is bot-suspected when bounce rate is ~99 to 100% AND average duration is very low (under ~15s); engaged sessions (2+ pages or an event) and known-human referrers (search/social/AI) are a human floor. Live on real getmasset.com data it flags the heavy Hong Kong / Singapore / China ~97%-bounce traffic. Reports human-vs-bot split so the marketer trusts the numbers.
- [x] **Cross-pillar insights** (`pages/api/insights.ts`, MCP `insights`). Joins SEO + analytics + AEO into plain-language findings and recommendations (e.g. high-traffic pages with no target keyword, keywords ranking with no traffic, AI-referral signal). Aggregates page rows by clean path first to avoid the UTM "last variant wins" trap.

## Test suite. DONE
- [x] Jest suites for the new utils: `__tests__/utils/ai-crawlers.test.ts`, `bot-filter.test.ts`, `bot-filter-aggregation.test.ts`, `ai-sources.test.ts`, `lodd.test.ts`, `site-crawl.test.ts` (10/10, includes a 6-target SSRF test) plus `site-crawl-edge.test.ts` (entity decoding, og:description fallback, script/style stripping, non-content pruning, depth ordering, link de-dup, more SSRF host classes), `lodd-domain-scope.test.ts`, `scope.test.ts`, `resolveAccount.test.ts`, the scoreboard AI-attribution path `__tests__/pages/scoreboard-ai-attribution.test.ts` (landing-path attribution, the no-landing-path note, the never-500 referral-throw degrade, and clean-path matching), and the deploy-readiness + briefing suites: `__tests__/pages/briefing-degradation.test.ts` (every pillar independently caught, never 500s, 400 missing domain), `__tests__/pages/login-demo-credentials.test.ts` (prod blocks demo/placeholder creds; dev unchanged), `__tests__/pages/settings-serp-env-fallback.test.ts` (DB value wins; env only fills empty). **22 suites pass (142 tests).** The 2 pre-existing UI/hook suites (`__tests__/hooks/domains.test.tsx`, `__tests__/pages/domain.test.tsx`) fail at suite load on the unrelated `KeywordsTable.tsx` / `useUpdateSettings` jsdom-env issue that predates this work and touches none of the new code.

## Analytics ownership: replace Lodd with self-hosted Umami (the standalone/sellable requirement)
- [x] Integration code: analytics layer is now provider-pluggable (utils/analytics.ts). Umami provider written (utils/umami.ts); Lodd demoted to legacy/dev. Default provider is umami. Lodd no longer load-bearing.
- [x] Host the instance: self-hosted Umami now runs publicly on Railway (Umami + Postgres). This is the owned analytics stack.
- [ ] Point s33k at the live Umami in production and add the Umami tracking script to getmasset.com so owned data starts flowing. (s33k/.env already points UMAMI_* at the Railway instance; ANALYTICS_PROVIDER stays 'lodd' for live verification until the tracking script is live, a separate human-approved step.)

### Closed gaps (this pass)
- [x] **Lodd per-domain scoping.** The Lodd provider read a fixed `LODD_SITE` regardless of the requested domain, so per-domain calls returned getmasset.com data for every domain. Added a domain-scoping guard: a request for a domain that does not match the configured Lodd site now returns zeros plus an explanatory `loddError`, instead of silently mislabeling getmasset.com data as another domain's. Test: `__tests__/utils/lodd-domain-scope.test.ts`. Live verified: `competitor.com` returns zeros + error.
- [x] **Umami per-page grain.** The Umami provider exposed aggregate counts but not per-page bounce_rate / avg_duration / parsed-UTM at that grain; extended so per-page rows carry the finer metrics the scoreboard and bot-filter need.
- [ ] `get_insight` still needs Google Search Console connected (Phase 1.5). Out of scope for this pass.

## Multi-tenant foundation (non-breaking). DONE (schema + scope helpers, shipped dark)
The standalone hosted-product step. Shipped as a non-breaking foundation behind a `MULTI_TENANT` flag (unset by default), so single-admin deployments are byte-for-byte unchanged. Full design in `MULTI_TENANT.md`.
- [x] Schema: new `account` and `api_key` tables (models + migrations), plus nullable `owner_id` on `domain` and `keyword`. All four migrations idempotent (the repo's `resolveQueryInterface` + `describeTable` dual-convention). `account` seeds exactly one row (the existing admin); all existing domain/keyword rows get `owner_id: null`, untouched.
- [x] Scope helpers: `utils/scope.ts` (`scopeWhere` / `ownerIdFor`) and `utils/resolveAccount.ts` short-circuit to today's behavior when `MULTI_TENANT` is off. Imported only by their own tests and the two model registrations; no production route adopts them yet.
- [x] Verified non-breaking live: every existing endpoint returns 200 with unchanged data (the only row delta is the additive `owner_id: null`).
- [ ] Next (the real hosted-product step, with Ben present): take the foundation from non-breaking schema to actually scoped (wire `scopeWhere` into the routes behind the flag, per-tenant API keys).

## Upstream PR plan. DONE (plan documented)
Full plan in `UPSTREAM_PR.md`: which changes are clean upstream contributions to `towfiqi/serpbear` (the MCP server, the one-click GSC OAuth, target-page mapping) versus which stay s33k-specific (analytics provider layer, AEO, multi-tenant). Sequencing and PR boundaries documented.

## Post-week (beyond Fork Week)
- [ ] Migrate s33k's own DB from SQLite to the same Postgres (one owned stack)
- [ ] s33k.io landing page

---

## Starter keyword set (kept small to stay on the free tier)

Strategic, winnable, on-positioning picks. These are intent + winnability + alignment calls, not volume data; once Google Search Console is connected we will see real impression data and refine.

| Keyword | Target page | Why it is impactful |
|---|---|---|
| masset | / | Brand baseline. Should be #1; catches aggregators or competitors outranking the brand term. |
| AI-ready DAM | /digital-asset-management-software | The core differentiated positioning. Low competition, ownable, defines the category Masset wants. |
| DAM MCP server | /software/mcp | Masset's unfair advantage. One of the only DAMs with an MCP server; genuinely winnable, on-trend. |
| AI digital asset management | /digital-asset-management-software | Category term with AI intent; aligns with positioning; winnable mid-tail. |
| Highspot alternative | /compare/masset-vs-highspot | Highest commercial intent. Biggest sales-enablement name; searchers are in-market. |
| Seismic alternative | /compare/masset-vs-seismic | Same logic, second-biggest name. |
| how to make website AI readable | /resources/blog/how-to-make-website-ai-readable | Strong existing pillar article; GEO-aligned, very winnable long-tail; proves content ranking. |

Expand once the scraper is confirmed free and the per-page view exists.
