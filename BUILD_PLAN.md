# s33k — Build Plan

**What s33k is:** one open, self-hosted tool that a marketer controls entirely from their LLM over MCP, combining three things they check constantly:
- **SEO** — where every page ranks in Google for its target keywords (SerpBear core).
- **Analytics** — page traffic and sources (start by reading Lodd's API; later replace Lodd with self-hosted Umami).
- **AEO** — whether ChatGPT, Claude, Perplexity, and Gemini mention and cite the brand vs competitors (built natively on top of the LLM connection).

The product is the **unified MCP control plane** that joins all three. Forked from `towfiqi/serpbear` (MIT). Domain: s33k.io.

**Documented up front:** the AI assistant assessed this as a multi-week product and recommended a scoped proof of concept; Ben overruled it and committed to a rough, installable V1 inside Fork Week. This plan is how we try.

---

## Phase 0 — Foundation (Day 3)
- [x] Fork SerpBear to `BenMasset/s33k`, name it, register s33k.io
- [x] Create local `.env`, run on port 3001 (marketing site holds 3000)
- [ ] Install deps and boot s33k locally
- [ ] Get a free **ScrapingRobot** API key (Ben: free account) and wire it as the SERP scraper
- [ ] Add the starter keyword set (below), each mapped to its target page
- [ ] First live Google rankings on the board

## Phase 1 — Per-page mapping (Day 4)
- [ ] Add a `target page` field to keywords (first real code we write into the fork)
- [ ] Group the keyword view by target page

## Phase 2 — The MCP control layer (Day 5, the headline)
- [ ] Build an MCP server over s33k's REST API: list/add/update keywords, read rankings + history, trigger refresh, read insights
- [ ] Connect it in Claude Code; from here, operate s33k entirely from AI
- [ ] Stretch: shape the MCP server as the upstream pull request to SerpBear

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
