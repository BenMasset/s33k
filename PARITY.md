# s33k Analytics Parity (vs Lodd)

The parity bar is Lodd's complete datapoint surface. This document records, per
Lodd datapoint, the s33k provider method, the MCP tool, the REST route, a real
sample value seen live against getmasset.com data, and whether s33k matches,
beats, or has a gap.

All sample values below were taken live on 2026-06-13 with `ANALYTICS_PROVIDER=lodd`
(real getmasset.com data), period `30d` unless noted, via the Bearer API key.

## Lodd parity table

| Lodd datapoint | Lodd endpoint | s33k provider method | s33k MCP tool | s33k API route | Live sample value (real) | Status |
|---|---|---|---|---|---|---|
| Totals | `/analytics` | `getSummary` | `traffic_summary` | `GET /api/summary` | pageviews 55, visitors 50, bounceRate 94, avgDuration 248.76s, pagesPerVisit 1.1 | MATCH |
| Per-page traffic | `/pages` | `getPageTraffic` | `page_scoreboard` | `GET /api/scoreboard` | top page `/` (Masset: B2B DAM for the AI Era): 9 pv, 9 uv, bounce 88.9, avg 25.8s, joined to keyword "masset" @ rank 1 | BEAT (joined to rank + content-gap detection) |
| Referrers + UTM | `/sources` | `getReferralSources` | `ai_referrals` | `GET /api/ai-referrals` | referred visitors 50; per-source classification carries utm_source/medium/campaign | MATCH |
| AI sources | `/sources` (`source_type=ai`) | `getReferralSources` (+ `classifyReferrer`) | `ai_referrals` | `GET /api/ai-referrals` | ChatGPT 2 visitors, Claude 1 visitor; AI share 6% of referred traffic | BEAT (works on any provider via our AI classifier, not only when the engine tags `source_type=ai`) |
| Countries | `/countries` | `getBreakdown('country')` | `traffic_breakdown` | `GET /api/breakdown?dimension=country` | US 42pv/37uv, HK 2/2, IN 2/2, SG 2/2, +7 more (11 rows) | MATCH |
| Devices | `/devices` | `getBreakdown('device')` | `traffic_breakdown` | `GET /api/breakdown?dimension=device` | desktop 41pv/37uv, mobile 14pv/13uv | MATCH |
| Browsers | `/browsers` | `getBreakdown('browser')` | `traffic_breakdown` | `GET /api/breakdown?dimension=browser` | Chrome 43pv/39uv, Safari 9/8, unknown 3/3 | MATCH |
| Operating systems | `/operating-systems` | `getBreakdown('os')` | `traffic_breakdown` | `GET /api/breakdown?dimension=os` | Mac 34pv/29uv, Windows 13/13, Linux 6/6, unknown 2/2 | MATCH |
| Session scores / engagement | `/session-scores` | `getEngagement` | `engagement` | `GET /api/engagement` | browsed 3 sessions (6%, avg 337.9s, 2.67 pages), bounced 47 sessions (94%) | MATCH |
| Events | `/events` | `getEvents` | `top_events` | `GET /api/events` | `[]` (Lodd events currently empty; shape honored) | MATCH |

## Extras beyond Lodd (s33k beats Lodd)

These have no Lodd endpoint. Lodd returns 404 for them; s33k serves them from
Umami. With `ANALYTICS_PROVIDER=lodd` the breakdown extras correctly return
`{ rows: [], error: "Not supported by Lodd" }` (verified live for `region`); with
`ANALYTICS_PROVIDER=umami` they return real rows.

| Extra datapoint | s33k provider method | s33k MCP tool | s33k API route | Notes |
|---|---|---|---|---|
| Region | `getBreakdown('region')` | `traffic_breakdown` | `GET /api/breakdown?dimension=region` | Umami metric `type=region`. Live (lodd provider) returns `"Not supported by Lodd"`. |
| City | `getBreakdown('city')` | `traffic_breakdown` | `GET /api/breakdown?dimension=city` | Umami metric `type=city`. |
| Language | `getBreakdown('language')` | `traffic_breakdown` | `GET /api/breakdown?dimension=language` | Umami metric `type=language`. |
| Screen | `getBreakdown('screen')` | `traffic_breakdown` | `GET /api/breakdown?dimension=screen` | Umami metric `type=screen`. |
| Time series | `getTimeSeries` | `traffic_timeseries` | `GET /api/timeseries` | Daily pageviews + visitors. Live (lodd, 7d): 2026-06-12 -> pageviews 55, visitors 50. Umami gives true daily buckets. |

## Conclusion

**Every Lodd datapoint is covered. Zero GAPs.** All ten Lodd datapoint categories
(totals, per-page, referrers+utm, ai-sources, countries, devices, browsers,
operating-systems, session-scores/engagement, events) have a provider method, an
MCP tool, and a REST route, each verified against live getmasset.com data.

**Where s33k beats Lodd:**

1. **Five extra dimensions Lodd cannot serve at all:** region, city, language,
   screen, and a true daily time series. These come free from the owned Umami
   engine and are exposed through the same `traffic_breakdown` / `traffic_timeseries`
   tools.
2. **Per-page traffic is joined to live Google rank and surfaces content gaps.**
   Lodd's `/pages` is just traffic; s33k's `page_scoreboard` joins each page to its
   tracked keywords and rank, flags traffic-with-no-keyword (content gaps), and
   flags keywords whose target page got no traffic.
3. **AI-referral detection is provider-independent.** Lodd only labels AI sources
   when its own `source_type` says `ai`; s33k classifies referrers with its own
   `classifyReferrer` (utils/ai-sources.ts), so AI attribution works on any
   analytics backend, including Umami, which has no AI tagging.
4. **The whole surface is MCP-controllable.** Every datapoint is reachable from an
   LLM over MCP with no UI, which Lodd does not offer.

**One honest caveat (not a Lodd parity gap):** when running on the Umami provider,
per-page rows and per-source rows expose aggregate counts but not per-page/per-source
`bounce_rate`, `avg_duration`, or parsed UTM fields, because Umami does not return
those at the page/source grain without session-level aggregation. On the Lodd
provider (current default for getmasset.com) those fields are present, so the live
parity bar is fully met. Closing the Umami grain gap is a future enhancement, not a
Lodd-parity gap.
