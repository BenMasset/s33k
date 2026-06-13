# s33k — Build Plan

**What s33k is:** one open, self-hosted tool that a marketer controls entirely from their LLM over MCP, combining three things they check constantly:
- **SEO** — where every page ranks in Google for its target keywords (SerpBear core).
- **Analytics** — page traffic and sources (start by reading Lodd's API; later replace Lodd with self-hosted Umami).
- **AEO** — whether ChatGPT, Claude, Perplexity, and Gemini mention and cite the brand vs competitors (built natively on top of the LLM connection).

The product is the **unified MCP control plane** that joins all three. Forked from `towfiqi/serpbear` (MIT). Domain: s33k.io.

**Documented up front:** the AI assistant assessed this as a multi-week product and recommended a scoped proof of concept; Ben overruled it and committed to a rough, installable V1 inside Fork Week. This plan is how we try.

---

## Guiding principle: 5 minutes to value

A friend should get from install to seeing real data in about five minutes. This is the bar every onboarding decision is measured against. Implication for data sources:
- **Serper is the day-one value path.** One API key, paste it, add keywords, see live rankings in ~2 minutes. This is what onboarding leads with.
- **Google Search Console is the richer opt-in layer, not the first step.** SerpBear's GSC connection is a service-account flow (create a Google Cloud project, service account, download a JSON key, paste client_email + private_key, add as a user in GSC): a 15-30 minute slog that breaks the 5-minute promise. So GSC is "level 2," connected after first value.
- **Build a one-click "Connect Google Search Console" OAuth** to replace the slog. SerpBear lacks this; it is a real differentiator and a strong upstream PR. Self-hosted wrinkle (OAuth redirect URIs) solved with a device-code flow or a small hosted auth broker. Roadmap item, not day one.

## Phase 0 — Foundation (Day 3)
- [x] Fork SerpBear to `BenMasset/s33k`, name it, register s33k.io
- [x] Create local `.env`, boot locally (Node 20 pinned; runs on port 3005)
- [x] Install deps and boot s33k locally (login works: admin / local placeholder)
- [x] Wire **Serper** as the SERP source (Ben added his key; verified working)
- [x] Add the starter keyword set, each mapped to its target page (target page parked in the `tags` field until Phase 1)
- [x] First live Google rankings on the board (getmasset.com: "masset" #1, "Seismic alternative" #38, the other 5 are opportunity gaps not yet in top 100). Scrape ran in ~11s.
- [ ] (Optional, level 2) Connect Google Search Console for real impression data

## Phase 1 — Per-page mapping (Day 4) — DONE
- [x] Add a `target_page` field to keywords (model + migration + API + types + parseKeywords). Existing keywords backfilled from tags.
- [x] Show target page in the keyword list (Target Page column) and an optional Target Page input in the Add-Keyword form. (Full per-page grouping view can come later; the column is in.)

## Phase 1.5 — Kill the GSC friction (the 5-min-to-value differentiator)
- [ ] Replace the GSC service-account paste with a one-click "Connect Google Search Console" OAuth button
- [ ] Handle the self-hosted redirect-URI problem (device-code flow or a small hosted auth broker)
- [ ] Shape it as an upstream pull request to SerpBear

## Phase 2 — The MCP control layer (Day 5, the headline) — DONE
- [x] Built an MCP server (`mcp/`) over s33k's REST API: list_domains, list_keywords (with target_page), add_keyword, refresh_keywords, get_insight. Verified returning live data over the MCP protocol.
- [x] verifyUser whitelist extended so add_keyword/add_domain work with the Bearer API key (headless). README has the Claude Code connect command. (Ben runs `claude mcp add` to wire it in.)
- [ ] Stretch: shape the MCP server as the upstream pull request to SerpBear
- [ ] Follow-up: `get_insight` needs Search Console connected (Phase 1.5), not yet wired

## Phase 3 — Analytics join (Day 6)
- [ ] Pull page traffic from Lodd's API (already in use, no new analytics tool needed yet)
- [ ] Join: per page, show traffic + target keywords + live rank in one view and one MCP tool

## Phase 4 — AEO / AI-visibility (Day 6-7, native feature)
- [ ] Run buyer-style prompts against the LLMs via the MCP layer; record brand mention + citation vs competitors
- [ ] Surface AI-citation rate per page, beside rank and traffic

## Phase 5 — Ship V1 (Day 7)
- [ ] Package so a friend can install: docker-compose, README, `.env` template
- [ ] Open the MCP pull request upstream
- [ ] Decide the model: free lead-gen for Masset, paid, or open-core (log in roadmap)

## Post-week (beyond Fork Week)
- [ ] Replace Lodd with self-hosted Umami for a fully owned analytics layer (the true Lodd replacement)
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
