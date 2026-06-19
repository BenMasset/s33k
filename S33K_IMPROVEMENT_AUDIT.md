# s33k Improvement Audit and AI Progress Log

Purpose: a shared, plain-English progress document that both Codex and Claude can read before
changing s33k. It records what looks worth improving, what was checked, and what comments or
guardrails were added so the next session does not restart the audit from scratch.

Last updated: 2026-06-18.

## How To Use This File

- Treat this as the live improvement backlog, not a guarantee that every issue is a bug.
- Update the status when work starts or finishes: `open`, `in progress`, `done`, `watch`.
- Add the verification command and result whenever an item is completed.
- Keep comments focused on durable intent and gotchas. Avoid comments that merely restate code.
- Keep the no-em-dash repo rule intact. Search for the U+2014 character before handing off.

## Current Snapshot

- MCP registry is currently 82 tools and 5 knowledge resources.
- The current shared tool registry is `mcp/src/tools.ts`, used by both stdio and hosted HTTP MCP.
- `CLAUDE.md` already reflects the 82-tool MCP architecture.
- `AGENTS.md` was stale at the start of this audit and still referenced 40 tools and `mcp/src/index.ts`.
- The worktree had pre-existing uncommitted billing and route-scope changes when this audit began.
- No U+2014 em dashes were found by searching for the literal em dash character.

## Priority Backlog

| ID | Area | Status | What Could Improve | Comments / Next Step |
|---|---|---|---|---|
| A1 | Repo instructions | done | Keep `AGENTS.md`, `CLAUDE.md`, and MCP docs in lockstep. | `AGENTS.md` and `CLAUDE.md` now both point here and describe the current 82-tool / `mcp/src/tools.ts` MCP architecture. |
| A2 | MCP docs | done | `BUILD_PLAN.md` still contains historical 20, 37, 39, and 40-tool milestones. | Added a current-state note to `BUILD_PLAN.md` and fixed the stale README MCP count/source. Historical entries remain preserved as build history. |
| A3 | Knowledge coverage | watch | The coverage guard is strong, but every new MCP tool still needs a `CapabilityEntry`. | Keep `__tests__/utils/knowledge-coverage.test.ts` as a required test after adding tools. |
| A4 | Legacy auth | done | Six API routes still use `verifyUser()` instead of `authorize()`: `clearfailed`, `settings`, `ideas`, `dbmigrate`, `adwords`, `logout`. | Audited as legacy cookie/admin or public OAuth callback surfaces. Added comments and a guard test that keeps them out of Bearer-key and scoped-share allowlists. Future tenant versions need `authorize()` plus owner-scoped storage first. |
| A5 | Public routes | watch | `login` and `collect` intentionally bypass `authorize()`. | `collect` is well-commented and domain-allowlisted. Keep it public because browser scripts cannot hold a secret. |
| A6 | Domain access consistency | done | Some routes still hand-roll `Domain.findOne({ domain, ...scopeWhere(account) })` instead of `resolveDomainAccess()`. | Per-domain API routes are now on `resolveDomainAccess()` for access checks, including onboarding reuse. Remaining direct `Domain.findOne` calls are intentional: public collect allowlist, provider website-id resolution, and Search Console storage helpers with owner-bound `where`. |
| A7 | CrawlerHit ownership | done | `CrawlerHit` has no visible owner scope in some destructive/export paths and is keyed by domain. | Documented the invariant on the model and fixed ingest to store the canonical owned domain (`owned.domain`) rather than the raw request variant. Reads/exports/deletes remain isolated by `resolveDomainAccess()` plus globally unique canonical domains. |
| A8 | Account delete | watch | `DELETE /api/account-data` is security-critical and irreversible. | Already heavily commented. Re-run focused tests after billing changes because it now touches account lifecycle expectations. |
| A9 | Billing rollout | done | Billing files are present in the dirty tree, but the end-to-end Stripe setup needs verification with webhook fixtures. | Focused billing/trial suites pass: plans, accept-trial, keyword cap, cron spend brake, webhook. Live Stripe CLI verification is still a deployment task. |
| A10 | Trial and spend brake | done | Trial expiry blocks keyword adds and cron scraping, but UX copy may need a consistent upgrade path. | Added a top-bar billing notice using `/api/billing/status`: trial countdown while trialing and a locked-state subscribe prompt when inactive. |
| A11 | Settings storage | open | `settings.json` still stores encrypted integrations in a file under `data`. | Acceptable for self-host legacy, but hosted Postgres path would be cleaner if settings moved to DB and owner scope. |
| A12 | Google Ads OAuth | done | `/api/adwords` has a public OAuth callback without a signed state, unlike Search Console OAuth. | Documented-why path (the GSC signed state does not apply: consent URL is built client-side, and Google Ads is a single global admin integration with no per-domain/owner binding to sign). Expanded the top-of-file comment in `pages/api/adwords.ts` per the A4 pattern and added `__tests__/utils/adwords-admin-only.test.ts` asserting the route stays out of both API-key allowlists. Verified: `npx jest --ci`, `npm run lint`, `npm run build` green. |
| A13 | Route status codes | done | Several routes still return 502 for unsupported methods or 200 for errors. | Fixed 14 routes 502->405 for method mismatch (`account`, `account-key`, `clearfailed`, `settings`, `refresh`, `ideas`, `insight`, `volume`, `domains`, `keywords`, `cron`, `searchconsole`, `me`, `searchconsole/connect`); left `adwords.ts` per A12. Fixed 4 real-error 200s: `settings.ts` missing body 200->400 and write-failure 200->500, `clearfailed.ts` write-failure 200->500, `keywords.ts` catch 200->500. Deliberately LEFT: analytics routes returning `status(200)` with a soft provider `error` (intentional degraded-but-successful partial reads, separate 500 catch); the newer s33k mutation routes (`account`, `domains`, `share`, etc.) whose catches already use 4xx (400), since 400 vs 500 is debatable and not the 200-on-error target. Tests: `__tests__/pages/route-status-codes.test.ts` (12 routes x 405 + keywords catch->500) and `__tests__/pages/route-status-codes-settings.test.ts` (settings 405/400/500 + clearfailed 500); 18 new assertions. Gate green: `npx jest --ci`, `npm run lint`, `npm run build`. Status-code-only; no auth/payload/logic changed. |
| A14 | Console logging | done | Client services and scraper utilities still use ad hoc `console.log`. | Removed debug/trace/success `console.log` noise and dead commented logs across client services (`services/*`), client `components/*`, and shared/scraper utils (`utils/scraper.ts`, `utils/refresh.ts`, `utils/adwords.ts`, `utils/searchConsole.ts`, `utils/domains.ts`, `utils/client/*`, `scrapers/services/proxy.ts`). Converted genuine catch-block diagnostics to `console.error` (kept all `[ERROR]`/`[WARN]` server tags) and turned two silently-swallowed catches into real `console.error` reports. No logging library introduced. Gate green: lint clean, 1116 jest tests pass, build compiled. |
| A15 | Type safety | open | `any` remains common in MCP handlers, scraper code, tests, and route payloads. | Start with shared response types for high-traffic routes, then MCP result mapping. Avoid massive churn. |
| A16 | Generated artifacts | done | `mcp/dist` and `mcp/node_modules` appear in local searches and can drown audits. | Verified both are gitignored (`.gitignore` lines 49-50) and neither is tracked (`git ls-files` empty). No action needed beyond excluding them in audit commands. |
| A17 | UI polish | open | Many pages are inherited SerpBear UI plus added product surfaces. | Focus first on onboarding, invite accept, billing locked state, and domain dashboard density. |
| A18 | Search Console docs | watch | OAuth Search Console is implemented, but older docs may still mention the service-account slog as primary. | Make README, install guides, and help text consistently lead with OAuth where configured. |
| A19 | Deployment docs | done | `DEPLOY.md` and older resume docs contain historical SQLite/Railway-volume guidance. | Added a prominent current-state banner to the top of `DEPLOY.md` and `RESUME_DEPLOY.md` (Postgres via DATABASE_URL, `railway up` is deterministic, s33k + Umami are separate projects), pointed to CLAUDE.md section A as authoritative, and marked the stale SQLite/volume sections below as HISTORICAL. History preserved. |
| A20 | Verification script | done | The verification loop is spread across docs. | Added `verify.sh` at the repo root: runs lint, jest --ci, root build, mcp build, and mcp smoke (smoke skipped gracefully when env is missing), Node-20-selected via nvm. Stops at the first failure. |

## Rank-Check Cadence + Pricing (added 2026-06-18, Claude)

- **Rankings are now checked ONCE A WEEK by default.** `cron.js` defaulted the SERP scrape interval
  to `daily`; changed to `weekly` (`0 0 * * 1`, Monday 00:00). cron.js runs in prod via the Dockerfile
  `concurrently "node server.js" "node cron.js"`. A self-hoster can still override `scrape_interval`.
- **Pricing model (in flight):** $7 per site / month, each site includes 50 tracked keywords, weekly
  rank checks, quantity = number of sites, 14-day no-credit-card trial (1 site / 50 keywords). The
  billing system is being converted from the earlier tier scaffold to this per-unit model.
- **Margin:** 50 keywords x ~4.3 weekly checks is about 217 SERP calls per site per month, roughly
  $0.22 to $0.43 in SERP cost at $7 revenue, so about 94 to 97 percent gross margin per site.

## Code Comments Added In This Pass

- Added legacy-auth context to `utils/verifyUser.ts`.
- Added file-backed settings context to `pages/api/settings.ts`.
- Added migration-route context to `pages/api/dbmigrate.ts`.
- Added failed-queue context to `pages/api/clearfailed.ts`.
- Added keyword-ideas legacy context to `pages/api/ideas.ts`.
- Added Google Ads OAuth risk context to `pages/api/adwords.ts`.
- Added logout cookie-only context to `pages/api/logout.ts`.

## Legacy Auth Route Audit

These routes still use `verifyUser()` by design for now. They are not in `allowedApiRoutes` and not
in `scopedKeyAllowedRoutes`, guarded by `__tests__/utils/legacy-admin-routes.test.ts`.

| Route | Current Classification | Why It Stays Legacy For Now | Future Upgrade |
|---|---|---|---|
| `/api/settings` | cookie/admin global settings | Reads and writes global `data/settings.json` credentials and scraper settings. | Move settings into owner-scoped DB rows, then migrate to `authorize()`. |
| `/api/clearfailed` | cookie/admin maintenance | Clears the global scraper retry queue. | Make failed queue tenant-aware before tenant access. |
| `/api/dbmigrate` | cookie/admin maintenance | Runs instance-level migrations. | Keep admin-only; do not expose to tenant keys. |
| `/api/ideas` | cookie/admin global Google Ads cache | Uses file-backed keyword-idea storage keyed by domain, not account. | Store ideas by owner/domain before tenant access. |
| `/api/adwords` | cookie/admin plus public OAuth callback | Stores global Google Ads credentials; callback currently lacks signed state. | Upgrade to signed-state OAuth and/or owner-scoped credentials. |
| `/api/logout` | cookie/UI only | Deletes the caller's browser cookie and touches no tenant data. | Revisit if per-account web sessions are added. |

## Checked Commands

These were used for the audit, not full verification:

```sh
git status --short
rg --files -g '!*node_modules*' -g '!*.next*' -g '!data*'
rg -n '<literal U+2014 em dash>' -g '!node_modules' -g '!.next' -g '!data'
node -e "parse mcp/src/tools.ts registerTool calls"
find pages/api -type f -name '*.ts' -print | while read -r f; do ... auth check ...; done
```

Full verification still needed after edits:

```sh
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1; npm run lint
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1; npx jest --ci
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1; npm run build
cd mcp && npm run build && npm run smoke
```

## Notes For The Next AI

- Start with `AGENTS.md`, `CLAUDE.md`, and this file.
- Respect existing dirty files. At audit start, billing and trial work was already uncommitted.
- When changing route auth, add tests before widening access. `allowedApiRoutes.ts` must stay dependency-free.
- When changing MCP tools, update `utils/knowledge.ts` and run the coverage test.
- When changing analytics or per-domain routes, verify the domain ownership gate happens before any pillar read.
