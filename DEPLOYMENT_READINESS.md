# s33k Deployment Readiness

Pre-deploy checklist for shipping the current branch (`phase1-2-target-page-and-mcp`) to the s33k
Railway project. The branch carries the night's build: 39 MCP tools + 5 resources, the multi-tenant
flag, and the new analytics/AEO/admin surfaces. Prod currently runs the pre-night code, so this is a
real upgrade, not a no-op.

This file is the operator checklist. `DEPLOY.md` is the long-form Railway recipe (note: its
SQLite-on-volume sections are historical, see CLAUDE.md section A). `CLAUDE.md` section A is the
source of truth for database choice and the deploy mechanism. No real secrets live in this file.

---

## 0. Pre-flight (run before you touch Railway)

- [ ] Node 20 via nvm: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20`
- [ ] `npm run lint` prints "No ESLint warnings or errors".
- [ ] `npm run build` prints "Compiled successfully".
- [ ] `npx jest --ci` is green (52 suites / 502 tests as of this branch).
- [ ] `cd mcp && npm run build` is clean, then `npm run smoke` against a live instance passes.
- [ ] `git status` is clean for everything you intend to ship. The deploy uploads your working tree.
- [ ] `.env` is still untracked (it is gitignored). Do NOT commit it, do NOT upload it.

---

## 1. Deploy steps (the only deterministic path)

The lesson from CLAUDE.md section A, do not relearn it: `railway up` uploads the local working tree
and deploys exactly that. `railway add --repo` and git-push deploys on API-created services build a
STALE pinned commit (no auto-deploy webhook), which once shipped an old unrelated commit and burned
hours. So git-push is for code review and history, NOT for making code live.

1. Push the branch (for review and history, this does NOT deploy):

   ```
   git push origin phase1-2-target-page-and-mcp
   ```

2. From the repo root, deploy the working tree to the s33k project:

   ```
   cd /Users/ben/Projects/s33k
   railway link        # if not already linked: pick project "s33k", the s33k service
   railway up          # uploads the working tree and deploys it
   ```

   `.railwayignore` keeps `.env`, `node_modules`, `.next`, and `data` out of the upload. It exists.
   Do not remove it.

3. Watch the build in `railway logs` (or the dashboard). First boot runs migrations against Postgres,
   then starts the server + cron. A `[SECURITY]` log line means a credential is still a demo or
   placeholder value and the boot was refused on purpose.

---

## 2. Environment variables the prod instance needs

Set these in the Railway "s33k" service Variables. Postgres lives in the SAME project; reference it
so the URL tracks the database. Umami lives in the SEPARATE "s33k-analytics" project and is read over
HTTPS cross-project (CLAUDE.md section A).

### Required

| Variable | Value / source | Notes |
|---|---|---|
| `DATABASE_URL` | Railway Postgres ref: `${{Postgres.DATABASE_URL}}` | Postgres in prod, never SQLite on a volume. The ref tracks the DB plugin. |
| `USER_NAME` | admin login username (e.g. `admin`) | Not the secret; the password is. |
| `PASSWORD` | strong admin password | `openssl rand -base64 24` or a manager value. |
| `SECRET` | `openssl rand -hex 34` | Encrypts stored keys, signs sessions. |
| `APIKEY` | `openssl rand -hex 24` | Bearer token for REST + MCP. Same value the MCP client reads as `S33K_API_KEY`. |
| `NEXT_PUBLIC_APP_URL` | the service public URL, `https://`, no trailing slash | e.g. `https://s33k-production.up.railway.app`. |
| `SCRAPER_TYPE` | `serper` | Env-configured scraping; no Settings-UI step required. |
| `SERPER_API_KEY` | your Serper key | From serper.dev. A UI-entered key always overrides this. |

`NODE_ENV=production` is baked into the image; do not set it. The app refuses to boot if `APIKEY`,
`SECRET`, or `PASSWORD` are unset, left as a `REGENERATE_ME...` placeholder, or set to the SerpBear
demo values.

### Analytics (Umami, the owned provider)

| Variable | Value / source | Notes |
|---|---|---|
| `ANALYTICS_PROVIDER` | `umami` | Default. Lodd is legacy. |
| `UMAMI_BASE_URL` | the s33k-analytics Umami URL | Cross-project HTTPS. |
| `UMAMI_WEBSITE_ID` | Umami website id | Optional. If blank, s33k matches by domain name. |
| `UMAMI_USERNAME` + `UMAMI_PASSWORD` | Umami admin creds | OR set a single pre-issued `UMAMI_API_KEY` instead. |
| `UMAMI_METRICS_TYPE` | `path` or `url` | Page-grouping metric. |

### Optional

| Variable | Value / source | Notes |
|---|---|---|
| `MULTI_TENANT` | `true` | Turns ON the new tenant features (invites, members, waitlist). Default off = single-admin, byte-for-byte unchanged. |
| `RESEND_API_KEY` | Resend API key | Enables invite + feature-request emails. Unset = send is skipped gracefully, no error. |
| `RESEND_FROM_EMAIL` | e.g. `s33k <invites@s33k.io>` | Optional override of the default from-address. |
| `FEATURE_REQUEST_NOTIFY_EMAIL` | destination inbox | Where `request_feature` notifications land. Unset = skipped. |
| `SEARCH_CONSOLE_CLIENT_EMAIL` + `SEARCH_CONSOLE_PRIVATE_KEY` | GSC service-account | Richer `get_insight` data. Both or neither. See follow-ups. |
| `SESSION_DURATION` | hours (default 24) | Login session length. |

---

## 3. Post-deploy verification

Set two shell vars first (replace with the real prod URL and APIKEY):

```
export S33K_URL="https://s33k-production.up.railway.app"
export S33K_KEY="your-APIKEY-value"
```

1. **Auth + REST liveness.** Should return JSON (the domain list), not a 401 or an HTML error page:

   ```
   curl -s "$S33K_URL/api/domains" -H "Authorization: Bearer $S33K_KEY"
   ```

   A 401 means `APIKEY` is wrong. An HTML 500 on a cold first DB hit is the known `discover_pages`
   edge (see follow-ups); other routes warm the DB and it self-heals.

2. **Full MCP surface against live prod.** From `mcp/`, point the smoke harness at prod and run it.
   Against a DB that already contains `getmasset.com` (the harness reads that domain), all 39 tools
   exercise cleanly; a fresh empty DB returns expected 403s for domain-scoped reads:

   ```
   cd /Users/ben/Projects/s33k/mcp
   S33K_BASE_URL="$S33K_URL" APIKEY="$S33K_KEY" npm run smoke
   ```

   Expect: `initialize` OK, `tools/list` exact 39, the read block green, mutating tools labeled
   SKIPPED (they provision/delete and are unit-covered instead).

3. **Seed getmasset.com if prod is a fresh DB.** Follow `DEPLOY.md` section 6 (add the domain, add
   keywords, refresh by id) so the analytics + rank join has real data to return.

4. **Confirm the new code is actually live.** The MCP banner should read
   "39 tools and 5 resources registered" and `tools/list` should return 39, not the pre-night 20.

---

## 4. Known follow-ups (not blockers, track separately)

- **getmasset.com analytics snippet swap.** Point the live getmasset.com analytics at the owned Umami
  so s33k reads first-party traffic for the scoreboard join. Until then the analytics pillar is only
  as complete as the configured Umami site.
- **GSC OAuth needs a Google Cloud app.** The one-click "Connect Google Search Console" flow requires
  a registered Google Cloud OAuth app + service account. Until that exists, GSC is the manual
  service-account-JSON path (`SEARCH_CONSOLE_*` env vars), which is the 15-30 minute slog SerpBear
  ships with. The OAuth friction-killer is roadmapped, not done.
- **Web pages design pass.** The new tenant-facing web pages (onboard, install instructions, invite
  accept, waitlist) have not had a brand/design pass against the Masset styleguide. Functional, not
  polished.
- **`discover_pages` cold-start.** `pages/api/discover.ts` is the one model-touching route that does
  not warm the DB connection itself, so it can throw a `ModelNotInitializedError` (HTML 500) if it is
  the very first DB route hit after a cold boot. It self-heals once any other DB route is hit. A
  one-line fix (add the `db` import + `await db.sync()` that peer routes already have) closes it.
  Low-severity, worth landing before or right after deploy.
- **Smoke harness read domain is hardcoded.** The harness reads `getmasset.com`, so it cannot fully
  validate a fresh empty instance without a seed step first. Parameterizing the read domain is a nice
  follow-up.

---

## 5. Bottom line

The branch is internally consistent: lint clean, build compiles, 52/502 tests green, MCP server
serves 39 tools + 5 resources with every new surface present. Deploy via `railway up` from the repo
root after pushing the branch, set the env vars above (Postgres reference + auth + Umami + Serper,
plus `MULTI_TENANT=true` and `RESEND_*` if you want the tenant features and invite emails), then
verify with `curl /api/domains` and the live smoke run. Ship it.
