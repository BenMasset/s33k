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
- [x] **MCP completeness: the whole product is now controllable from MCP with no UI (V1 surface).** 18 tools registered and verified over stdio (`tools/list` + live `tools/call`):
  - SEO/control: list_domains, create_domain, list_keywords, add_keyword, update_keyword, delete_keyword, refresh_keywords, get_insight.
  - Analytics (full Lodd parity + extras): page_scoreboard, ai_referrals, traffic_summary, traffic_breakdown, traffic_timeseries, top_events, engagement.
  - 10x signals (beyond commodity analytics): ai_crawlers (answer-engine bot detection), human_traffic (bot-vs-human filtering), insights (cross-pillar SEO + analytics + AEO findings).
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
- [ ] Later: per-page AI-citation rate beside rank and traffic (would join referral landing pages into the scoreboard).

## Phase 5: Ship V1 (Day 7). DONE (install package)
- [x] Package so a friend can install: `deploy/docker-compose.yml` (s33k + Umami + Postgres in one stack) and `deploy/.env.template` (placeholders and throwaways only, with openssl regenerate instructions; zero real secrets). README rewritten with the three-pillar story, install steps, and the full 18-tool MCP table.
- [ ] Open the MCP pull request upstream
- [ ] Decide the model: free lead-gen for Masset, paid, or open-core (log in roadmap)

## The 10x: AI-native signals beyond commodity analytics. DONE
The differentiator over Lodd/Plausible is being the AI-native analyst across the joined pillars, plus signals dashboards do not capture. Three shipped, each MCP-controllable and Bearer-reachable over REST:
- [x] **AI-crawler detection** (`utils/ai-crawlers.ts`, `pages/api/ai-crawlers.ts`, `database/models/crawlerHit.ts` + migration, MCP `ai_crawlers`). Classifies answer-engine bot user-agents (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-Web, anthropic-ai, Claude-User, PerplexityBot, Perplexity-User, Google-Extended, Googlebot, Applebot-Extended, Bingbot, Amazonbot, Bytespider, CCBot, Meta-ExternalAgent/FacebookBot, DuckAssistBot, cohere-ai, YouBot, Diffbot, ImagesiftBot) to a normalized owner (OpenAI, Anthropic, Perplexity, Google, Apple, Microsoft, Amazon, Meta, etc.) and an is-answer-engine flag. `POST /api/crawler-hit` ingests a hit; `GET /api/ai-crawlers` reports who crawled. Answers "are the AI engines actually reading my site," which no rank tracker shows.
- [x] **Human-vs-bot traffic filtering** (`utils/bot-filter.ts`, `pages/api/human-traffic.ts`, MCP `human_traffic`). Ports the working heuristic from `lodd-traffic/traffic.py`: a segment is bot-suspected when bounce rate is ~99 to 100% AND average duration is very low (under ~15s); engaged sessions (2+ pages or an event) and known-human referrers (search/social/AI) are a human floor. Live on real getmasset.com data it flags the heavy Hong Kong / Singapore / China ~97%-bounce traffic. Reports human-vs-bot split so the marketer trusts the numbers.
- [x] **Cross-pillar insights** (`pages/api/insights.ts`, MCP `insights`). Joins SEO + analytics + AEO into plain-language findings and recommendations (e.g. high-traffic pages with no target keyword, keywords ranking with no traffic, AI-referral signal). Aggregates page rows by clean path first to avoid the UTM "last variant wins" trap.

## Test suite. DONE
- [x] Jest suites for the new utils: `__tests__/utils/ai-crawlers.test.ts`, `bot-filter.test.ts`, `bot-filter-aggregation.test.ts`, plus the existing `ai-sources.test.ts` and `lodd.test.ts`. All util suites pass (40/40 across the 5 suites). The 2 pre-existing UI/hook suites (`__tests__/hooks/domains.test.tsx`, `__tests__/pages/domain.test.tsx`) fail on unrelated msw/TextEncoder and mock-setup issues that predate this work and touch none of the new code.

## Analytics ownership: replace Lodd with self-hosted Umami (the standalone/sellable requirement)
- [x] Integration code: analytics layer is now provider-pluggable (utils/analytics.ts). Umami provider written (utils/umami.ts); Lodd demoted to legacy/dev. Default provider is umami. Lodd no longer load-bearing.
- [ ] Host the instance: run Umami + the official Postgres image via docker-compose (Postgres is the chosen DB: free, commercially unrestricted PostgreSQL License, flexible). This same compose doubles as the product installer.
- [ ] Point s33k at the live Umami (UMAMI_BASE_URL / website id / auth) and add the Umami tracking script to getmasset.com so owned data starts flowing.

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
