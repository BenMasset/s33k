# Upstream contribution plan: a SerpBear MCP server

Fork Week give-back to `towfiqi/serpbear` (MIT). This document is the plan only.
No upstream files are modified, nothing is pushed, and no PR is opened by this run.
Ben opens the PR himself from the `BenMasset/s33k` fork.

---

## 1. What to contribute, and why this one

**Contribute: a Model Context Protocol (MCP) server for SerpBear, scoped to
SerpBear's own native REST API, plus the tiny `verifyUser` whitelist additions
that make SerpBear's existing keyword/domain write routes reachable with the
API key.**

This lets any SerpBear user drive their rank tracker from an LLM client (Claude
Code, Claude Desktop, Cursor, etc.) over one connection: list domains, add a
domain, list keywords with live Google rankings and history, add/update/delete
keywords, trigger a fresh SERP scrape, and read Search Console insight. No new
product surface, no new data model, no s33k branding.

### Why it fits SerpBear and is NOT s33k-specific

- **Every tool wraps an endpoint SerpBear already ships.** Verified against
  `upstream/main`: `/api/domains` (GET, POST), `/api/keywords` (GET, POST, PUT,
  DELETE), `/api/refresh` (POST), `/api/insight` (GET) all exist in upstream
  today. The MCP server adds zero new routes, zero new tables, zero new
  migrations. It is a thin, read-and-write client over the public API that
  SerpBear maintainers already support.
- **It uses SerpBear's existing auth as-is.** SerpBear already has a Bearer
  API-key path in `utils/verifyUser.ts` with an `allowedApiRoutes` whitelist.
  The server authenticates with that same `APIKEY`. The only code change to
  SerpBear itself is widening that whitelist (details in section 4) so the
  already-existing `POST/PUT/DELETE /api/keywords` and `POST /api/domains`
  routes can be used headlessly, which is squarely in the spirit of the
  feature that is already there.
- **It is generically valuable.** "Control my rank tracker from my AI assistant"
  is a SerpBear-shaped feature, not a Masset/s33k-shaped one. MCP is the current
  standard for exactly this. Upstream has no MCP server today (confirmed: no MCP
  reference in upstream README).
- **It is self-contained.** Lives entirely in a new `mcp/` subdirectory with its
  own `package.json` and build. It does not touch the Next.js app's runtime,
  dependencies, or build. A maintainer can merge it and ship it without it being
  able to break the existing app.

### Why NOT contribute the rest of s33k

Deliberately excluded, because these are s33k product scope and depend on routes
and a data model that do not exist in upstream SerpBear:

- The analytics layer (`utils/analytics.ts`, `utils/lodd.ts`, `utils/umami.ts`)
  and its routes (`/api/summary`, `/api/breakdown`, `/api/timeseries`,
  `/api/events`, `/api/engagement`, `/api/scoreboard`).
- AEO/AI features: AI referrals (`/api/ai-referrals`), AI crawler detection
  (`/api/ai-crawlers`, `crawler-hit`, the `crawlerHit` model + migration),
  human-vs-bot filtering (`/api/human-traffic`), cross-pillar insights
  (`/api/insights`), and page discovery (`/api/discover`).
- The `target_page` keyword field (model change + migration + UI).

Contributing those would force SerpBear to adopt s33k's whole analytics/AEO
product. That is not an upstream-appropriate ask. The MCP-over-native-API slice
is the clean, mergeable subset.

**Smaller fallback if the maintainer does not want a new `mcp/` package at all:**
open just the `verifyUser` whitelist widening (section 4) as a 4-line PR titled
"Allow keyword create/update/delete and domain create over the API key." It is
independently useful: it completes SerpBear's existing headless API so the
documented programmatic write routes actually work with the API key. The MCP
server is the stronger, more visible contribution; the whitelist change is the
safe minimum.

---

## 2. PR title and description

**Title:**
`Add an MCP server so SerpBear can be controlled from an LLM`

**Description (paste into the PR body):**

> ### What
>
> Adds an optional Model Context Protocol (MCP) server under `mcp/` that lets
> any LLM client (Claude Code, Claude Desktop, Cursor, and other MCP clients)
> operate a running SerpBear instance over a single stdio connection.
>
> Tools exposed (each is a thin wrapper over SerpBear's existing REST API):
>
> | Tool | Wraps | Does |
> |---|---|---|
> | `list_domains` | `GET /api/domains` | List tracked domains |
> | `create_domain` | `POST /api/domains` | Add one or more domains |
> | `list_keywords` | `GET /api/keywords` | List a domain's keywords with current rank, ranking URL, and 7-day history |
> | `add_keyword` | `POST /api/keywords` | Add a keyword (queues a SERP scrape) |
> | `update_keyword` | `PUT /api/keywords` | Toggle sticky on keywords |
> | `delete_keyword` | `DELETE /api/keywords` | Delete keywords |
> | `refresh_keywords` | `POST /api/refresh` | Trigger a fresh SERP scrape by IDs or whole domain |
> | `get_insight` | `GET /api/insight` | Read Google Search Console insight (top pages/keywords/countries/stats) |
>
> The server authenticates with the existing SerpBear `APIKEY` (Bearer) and runs
> fully headless. It adds no new routes, no new tables, and no new runtime
> dependency to the Next.js app. It lives in its own `mcp/` package with its own
> `package.json` and build.
>
> ### Why
>
> MCP is the emerging standard for letting AI assistants drive tools. This makes
> SerpBear's rank tracking usable from the same place people are increasingly
> doing their SEO work (their LLM), without any UI. Everything it does is already
> possible via the REST API; this just makes it ergonomic from an LLM.
>
> ### One small change to SerpBear itself
>
> SerpBear already supports an API-key path in `utils/verifyUser.ts`, but its
> `allowedApiRoutes` whitelist only lists `GET /api/keywords`, `GET /api/domains`,
> and a few POSTs. The keyword create/update/delete and domain-create routes
> already exist and work with a session cookie, but are not reachable with the
> API key. This PR adds them to the whitelist so the documented write routes work
> headlessly:
>
> ```
> 'POST:/api/keywords',
> 'PUT:/api/keywords',
> 'DELETE:/api/keywords',
> 'POST:/api/domains',
> ```
>
> No behavior changes for cookie-authenticated users; this only widens what the
> API key may reach, consistent with the existing API-key design.
>
> ### Try it
>
> ```bash
> cd mcp && npm install && npm run build
> claude mcp add serpbear \
>   -e SERPBEAR_API_KEY=YOUR_APIKEY \
>   -e SERPBEAR_BASE_URL=http://localhost:3000 \
>   -- node ./mcp/dist/index.js
> ```
>
> Docs are in `mcp/README.md`. Happy to adjust scope, naming, or drop the
> whitelist change into a separate PR if you'd prefer to review them apart.

---

## 3. Exact files involved in the PR

**New files (the MCP package, all under `mcp/`):**

- `mcp/src/index.ts` — the server. **Must be trimmed to the 8 native-API tools**
  (see section 4 for exactly what to remove).
- `mcp/package.json` — rename `name` from `s33k-mcp` to `serpbear-mcp`; update
  `description` and the `bin` key. No s33k references.
- `mcp/tsconfig.json` — unchanged, already generic.
- `mcp/README.md` — rewrite to remove every s33k/Masset/Lodd/Umami reference and
  every hardcoded `/Users/ben/...` path and port `3005`; document only the 8
  native tools and the generic env var names.
- `mcp/.gitignore` — add one: `node_modules/` and `dist/`. (Currently the s33k
  repo ignores these at the root; the upstream PR should carry its own so the
  `mcp/` package is self-contained. Do NOT commit `mcp/dist/` or
  `mcp/node_modules/`.)

**Modified upstream file (one, four added lines):**

- `utils/verifyUser.ts` — add the four whitelist entries listed in section 2.

**Explicitly NOT in the PR** (these are s33k product scope; do not include):
`pages/api/{ai-crawlers,ai-referrals,breakdown,crawler-hit,discover,engagement,events,human-traffic,insights,scoreboard,summary,timeseries}.ts`,
`utils/{analytics,lodd,umami,ai-sources,ai-crawlers,bot-filter}.ts`,
`services/*`, `components/{aitraffic,scoreboard}/*`, the `crawlerHit` model and
both new migrations, the `target_page` keyword field changes
(`pages/api/keywords.ts`, `database/models/keyword.ts`, `utils/parseKeywords.ts`,
the target-page migration, and the related UI), `BUILD_PLAN.md`, `PARITY.md`,
`deploy/*`, `__tests__/utils/*`, and the root `README.md`/`.env.example`/`.nvmrc`
changes.

---

## 4. Changes required to make it generic (prep edits, to be done on a dedicated branch later)

These are the edits Ben (or a later run) makes on a fresh branch cut from
`upstream/main` before opening the PR. They are described here, not performed now.

### 4a. Trim `mcp/src/index.ts` to the 8 native tools

**Keep:** `list_domains`, `create_domain`, `list_keywords`, `add_keyword`,
`update_keyword`, `delete_keyword`, `refresh_keywords`, `get_insight`.

**Remove the 11 s33k-only tools** (they wrap routes that do not exist upstream):
`page_scoreboard`, `ai_referrals`, `ai_crawlers`, `traffic_summary`,
`human_traffic`, `traffic_breakdown`, `traffic_timeseries`, `top_events`,
`engagement`, `insights`, `discover_pages`.

**De-s33k the kept tools:**

- `list_keywords`: drop the `target_page` field from the returned object mapping
  (upstream keywords have no `target_page`). Keep `ID, keyword, device, country,
  position, url, history`.
- `add_keyword`: remove the `target_page` input and stop sending `target_page`
  in the POST body. Upstream `addKeywords` accepts `keyword, device, country,
  domain, tags, city`; send those (tags/city optional) and drop `target_page`.
- `update_keyword`: upstream `updateKeywords` accepts `sticky` and `tags` (not
  `target_page`). Rewrite this tool to set `sticky` (and optionally `tags`).
  Remove the `target_page` branch.

**Rename identity and env vars (no s33k strings anywhere):**

- Server `name`: `s33k-mcp` -> `serpbear-mcp`. `version` is fine at `0.1.0`.
- Header comment block: rewrite to describe SerpBear, not s33k.
- Env vars: `S33K_API_KEY` -> `SERPBEAR_API_KEY`,
  `S33K_BASE_URL` -> `SERPBEAR_BASE_URL`. Default base URL `http://localhost:3005`
  -> `http://localhost:3000` (SerpBear's documented default port).
- The `s33kFetch` helper and the stderr prefix `s33k-mcp:` -> `serpbearFetch` /
  `serpbear-mcp:`.
- The final startup line "19 tools registered" -> "8 tools registered".

### 4b. `mcp/package.json`

- `name`: `serpbear-mcp`. `bin` key: `serpbear-mcp`.
- `description`: "MCP server that lets an LLM control SerpBear (open-source rank
  tracker) over its REST API."
- Remove `"private": true` only if Ben intends it to be publishable; otherwise
  leave it. Dependencies (`@modelcontextprotocol/sdk`, `zod`) and devDeps are
  already generic and stay.

### 4c. `mcp/README.md`

- Replace all `s33k` with `SerpBear`. Remove all Masset/Lodd/Umami mentions.
- Replace the hardcoded `/Users/ben/Projects/s33k/mcp/dist/index.js` paths with a
  relative `./mcp/dist/index.js` (or `<repo>/mcp/dist/index.js`).
- Replace port `3005` with `3000` and `S33K_*` with `SERPBEAR_*`.
- Cut the tool table down to the 8 native tools. Fix "five s33k tools" /
  "5 tools registered" copy to "8 tools".
- Note that the four keyword/domain write routes require the `verifyUser`
  whitelist change shipped in the same PR (so a reviewer on an older SerpBear
  knows why writes 401 without it).

### 4d. `utils/verifyUser.ts` (the only upstream-app change)

Add exactly these four entries to `allowedApiRoutes` (and nothing else; do NOT
carry over the s33k analytics/AEO routes):

```
'POST:/api/keywords',
'PUT:/api/keywords',
'DELETE:/api/keywords',
'POST:/api/domains',
```

### 4e. No em dashes

The MCP source and README already avoid em dashes. Keep it that way in any
rewrite. (Note: four unrelated upstream files in the s33k tree contain em dashes
— `utils/scraper.ts`, `pages/api/settings.ts`,
`components/settings/ScraperSettings.tsx`, `components/domains/DomainSettings.tsx`
— those are pre-existing upstream content and are NOT part of this PR.)

---

## 5. Step-by-step for Ben to open the PR

Run from a clean state. This builds the PR branch from `upstream/main` so it
contains ONLY the give-back, none of the s33k product code. Replace the Node
preamble as needed.

```bash
# 0. Node 20
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20

cd /Users/ben/Projects/s33k

# 1. Make sure upstream is current
git fetch upstream

# 2. Cut a clean PR branch straight off upstream/main (NOT off the s33k branch)
git checkout -b upstream-mcp-server upstream/main

# 3. Bring over ONLY the mcp/ package from the s33k branch, then trim it
git checkout phase1-2-target-page-and-mcp -- mcp/src/index.ts mcp/package.json mcp/tsconfig.json mcp/README.md
#    Do the section-4 generic edits now:
#      - trim mcp/src/index.ts to the 8 native tools, rename S33K_* -> SERPBEAR_*, port 3000
#      - rewrite mcp/package.json name/description/bin to serpbear-mcp
#      - rewrite mcp/README.md (remove s33k/Masset/Lodd/Umami, fix paths/port/tool count)
#      - add mcp/.gitignore with node_modules/ and dist/

# 4. Apply ONLY the four-line verifyUser whitelist change (section 4d) by hand.
#    Do NOT git-checkout the s33k verifyUser.ts wholesale: it carries the
#    analytics/AEO routes you are excluding. Edit upstream's file to add just
#    the 4 keyword/domain write entries.

# 5. Build the MCP package to confirm it compiles, but do NOT commit dist/
cd mcp && npm install && npm run build && cd ..

# 6. SECRET HYGIENE: confirm no real keys are in the staged changes
git add mcp/src mcp/package.json mcp/tsconfig.json mcp/README.md mcp/.gitignore utils/verifyUser.ts
git diff --cached | grep -iE 'APIKEY=|SERPER|LODD_API_KEY|APP_SECRET|sk-|Bearer [A-Za-z0-9]{20}' && echo "STOP: secret found, do not commit" || echo "clean"
#    Verify mcp/dist and mcp/node_modules are NOT staged:
git status --porcelain | grep -E 'mcp/(dist|node_modules)' && echo "STOP: build artifacts staged" || echo "no artifacts staged"

# 7. Commit
git commit -m "Add an MCP server so SerpBear can be controlled from an LLM"

# 8. Push to Ben's fork
git push -u origin upstream-mcp-server

# 9. Open the PR against upstream from the fork
gh pr create \
  --repo towfiqi/serpbear \
  --base main \
  --head BenMasset:upstream-mcp-server \
  --title "Add an MCP server so SerpBear can be controlled from an LLM" \
  --body-file - < /dev/stdin   # paste the section-2 description, or use --body
```

If `gh pr create` against the upstream repo is awkward, open it in the browser:
go to `https://github.com/towfiqi/serpbear`, click "Compare & pull request" on
the `BenMasset:upstream-mcp-server` branch banner, set base = `towfiqi/serpbear`
`main` and compare = `BenMasset/s33k` `upstream-mcp-server`, paste the section-2
title and description.

---

## 6. Pre-PR checklist

- [ ] Branch is cut from `upstream/main`, not from the s33k feature branch.
- [ ] Only `mcp/*` (8 tools) and the 4-line `utils/verifyUser.ts` change are in
      the diff. No analytics/AEO routes, no `target_page`, no `deploy/`, no
      `BUILD_PLAN.md`/`PARITY.md`, no root README/.env changes.
- [ ] Zero occurrences of `s33k`, `Masset`, `Lodd`, `Umami`, `getmasset`,
      `/Users/ben`, or port `3005` anywhere in the diff
      (`git diff --cached | grep -iE 's33k|masset|lodd|umami|getmasset|/Users/ben|3005'`
      returns nothing).
- [ ] `mcp/dist/` and `mcp/node_modules/` are not staged.
- [ ] No real Serper key, Lodd key, Umami `APP_SECRET`, or SerpBear `APIKEY`
      appears in any committed file (section 6 of the runbook greps for these).
- [ ] No em dashes in the added files.
- [ ] `npm run build` in `mcp/` compiles cleanly.

---

## 7. Status of this run

- Read-mostly. The only file written is this one (`UPSTREAM_PR.md`).
- No upstream files modified. Nothing pushed. No PR opened. No branch switched.
- The generic-ization edits in section 4 are described as a plan; they are to be
  performed later on the `upstream-mcp-server` branch, not on
  `phase1-2-target-page-and-mcp`.
