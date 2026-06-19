# s33k: repo door-sign for the next AI session

s33k (reads "seek") is an open, self-hosted, MCP-native SEO + AEO + Analytics suite. A marketer
controls all of it from their own LLM over MCP. Forked from `towfiqi/serpbear` (MIT). Domain
`s33k.io`, prod at https://s33k-production.up.railway.app.

The product is the unified MCP control plane that joins three pillars a marketer checks constantly:
SEO (per-page keyword rank in Google), Analytics (traffic + sources, Umami-backed), and AEO/GEO
(do AI engines crawl, cite, and refer you). The join across all three, per page, is the thing no
other tool does.

This file is for the AI doing the work. Read it before you build. Add to it when you hit a
hard-won lesson, so the next session never relearns it.

---

## Runtime + commands (get this right first)

- **Node 20 via nvm, locally.** `jsonwebtoken` crashes on Node 25. Prefix node/npm in any shell
  line: `export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh"; nvm use 20 >/dev/null 2>&1;`
- **Tests:** `npx jest --ci` (one-shot). `npm run test` is WATCH mode, do not use it for verification.
- **Lint:** `npm run lint` must be clean. **Build:** `npm run build` must print "Compiled successfully".
- **MCP server:** `cd mcp && npm run build`, then probe over a real stdio handshake. 82 tools + 5
  resources today. Banner reads "82 tools and 5 resources registered." Smoke harness: `npm run smoke`
  from `mcp/`. The smoke test's EXPECTED_TOOLS and the registered set are kept in lockstep by a jest
  guard (`__tests__/utils/knowledge-coverage.test.ts`), so this count cannot silently rot.
- **Two MCP transports, one tool set.** The 82 tools live in `mcp/src/tools.ts` (`registerS33kTools`).
  `mcp/src/index.ts` is the thin stdio entry; `pages/api/mcp/[[...slug]].ts` is the hosted Streamable
  HTTP endpoint at `/api/mcp` (connect with a URL + Bearer key, no install). Both register the SAME
  tools, each binding its own per-connection key. See section D below.
- **AI improvement backlog:** read `S33K_IMPROVEMENT_AUDIT.md` after this file. It is the shared
  Codex/Claude progress log for repo-wide improvements, open risks, and durable code comments.
- **Do not touch a running dev server or `.env`.** `.env` is gitignored and must stay untracked.

---

## A. Hard-won deploy gotchas (the most valuable section, do not relearn these)

### Database: Postgres in prod, never SQLite on a Railway volume
- SQLite-on-a-mounted-volume threw `SQLITE_CANTOPEN` even running as root with an absolute path.
  The combination of the volume mount and the Next.js standalone runtime cwd is the cause. Stop
  trying to make SQLite-on-volume work. Use Postgres in prod.
- The app supports BOTH via `DATABASE_URL`: Postgres when `DATABASE_URL` is set, SQLite locally.
  The seam is `database/database.ts` (runtime Sequelize) and `database/config.js` (migrations CLI).
  Both branch on `process.env.DATABASE_URL`.
- `pg` and `@types/pg` are dependencies. The `CrawlerHit` model id is `ID` mapped to the `id`
  column. That mapping is a `@types/pg`-strictness fix, keep it.
- `DATABASE_PATH` is the absolute-path env for the SQLite branch (local/legacy). Irrelevant under
  Postgres.

### Railway deploys: `railway up` is the deterministic path
- **`railway up` uploads the local working tree and deploys it. That is the deterministic deploy.**
- **`railway add --repo` / git-push deploys build a STALE pinned commit** on API-created services
  (no auto-deploy webhook). The s33k service once shipped an old, unrelated commit this way and
  burned hours. Until you run `railway up`, new code is working-tree-only and is NOT live.
- `.railwayignore` keeps `.env`, `node_modules`, `.next`, `data`, etc. out of the `railway up`
  upload. It exists; do not remove it.

### Railway project layout
- s33k lives in its OWN Railway project named "s33k" with a dedicated Postgres.
- Umami lives in a SEPARATE project, "s33k-analytics" (Railway caps 3 volumes per project, which
  forced the split). s33k reads Umami over HTTPS cross-project.
- Prod URL: https://s33k-production.up.railway.app.
- Note: `DEPLOY.md` and `RESUME_DEPLOY.md` describe the EARLIER SQLite-on-volume + su-exec saga and
  the old single-project layout. They are historical. This file is current for database + layout.

### Node + container
- Node 20 via nvm locally (see above). The Dockerfile uses `node:22-alpine`, which is fine.
- The container runs as ROOT on purpose. This was the deliberate fix for the volume-permission
  saga (Railway mounts the volume root-owned at runtime). The Dockerfile intentionally does NOT set
  `USER nextjs`. Leave it.

---

## B. Code patterns the next session must follow

### Multi-tenant is flag-gated behind `MULTI_TENANT` (default off = byte-for-byte unchanged)
- With the flag off, every caller resolves to admin, `scopeWhere` returns `{}`, and behavior is
  identical to single-tenant. Keep it that way: all multi-tenant changes are additive and flag-safe.
- **Data routes:** call `authorize()` (`utils/authorize.ts`) for auth + account resolution +
  member/whitelist enforcement, then spread `scopeWhere(account)` (`utils/scope.ts`) into EVERY
  `Domain` / `Keyword` / `CrawlerHit` / `S33kEvent` query, and stamp `ownerIdFor(account)` on every
  create.
- **Analytics routes:** verify domain ownership first:
  `Domain.findOne({ where: { domain, ...scopeWhere(account) } })` → 403 if not found, BEFORE any
  pillar read. The `domain` column is globally `@Unique`, so by-domain scoping cannot leak across
  tenants (a domain name belongs to exactly one account).
- **Member API keys (`role: 'member'`) are GET-only**, enforced in `authorize()` before the request
  reaches the route. Members only exist with `MULTI_TENANT` on.

### Every new MCP tool MUST get a knowledge entry (the build enforces it)
- Add a `CapabilityEntry` to `utils/knowledge.ts` for any new tool, or the knowledge-coverage jest
  test FAILS the build. This is the self-support durability guarantee: a user's own LLM must be able
  to answer any question about the tool, so the answers can never silently rot.
- Tools are registered in `mcp/src/tools.ts` (`registerS33kTools`, 82 tools + 5 resources today),
  shared by the stdio entry (`mcp/src/index.ts`) and the hosted HTTP route (`pages/api/mcp`). The
  knowledge-coverage jest guard parses `tools.ts`, so any new tool there still needs a knowledge entry.
- Whitelist any new authed API route in `utils/allowedApiRoutes.ts`. Keep that file
  DEPENDENCY-FREE: no DB-model imports. Importing a model drags sequelize/uuid ESM into jest and
  breaks suites. That exact regression happened and was fixed. Do not reintroduce it.

### Model column names must match the migration EXACTLY (Postgres is case-sensitive)
- A new model used `field: 'id'` (lowercase) while its create-table migration keyed the column `ID`.
  On SQLite (case-insensitive) it worked; on Postgres `"id"` != `"ID"`, so every read of that model
  threw "column does not exist" and the route returned a generic 400. Rule: the model attribute's
  column name (the `field:` if set, else the attribute name) must byte-match the column the
  migration creates. Also register every new model in `database/database.ts`'s `models` array.
  Migrations run on boot via `entrypoint.sh` (`sequelize-cli db:migrate --env production`), which now
  FAILS LOUD: a non-zero migrate exit triggers `exit 1`, so the container refuses to boot on a broken
  migration rather than starting against a missing/mismatched table. (This replaced the earlier
  boot-through-failure behavior; do not reintroduce that.) The migrations themselves only swallow
  IDEMPOTENCY (already-applied) errors, never real ones.

### Import provider/util classes STATICALLY, never via runtime `require('./x').Named`
- A dynamic `const { UmamiProvider } = require('./umami')` resolved to `undefined` in the Next
  STANDALONE production bundle (`new UmamiProvider()` threw "is not a constructor"), even though
  the export map registered the full name. Next/webpack does not reliably expose a harmony (ESM)
  NAMED export through a runtime require in standalone output. Jest never caught it (jest runs
  source, not the bundle) and it only fired on the configured provider (Umami on prod), so a
  Lodd-path local test looked green. Fix: `import { UmamiProvider } from './umami'` at module top.
  Static imports are rewritten correctly by webpack and are the durable form. The lazy-require was
  a micro-optimization not worth a prod-breaking footgun. To reproduce a bundle-only bug like this:
  `npm run build`, copy `data/database.sqlite` into `.next/standalone/data/`, `export
  ANALYTICS_PROVIDER=umami`, run `node .next/standalone/server.js`, and curl the route.

### OAuth callbacks are public routes secured by a SIGNED state, not the API-key whitelist
- The "Connect Google Search Console" flow is two routes: `/api/searchconsole/connect` (GET,
  authed + owner-gated via `resolveDomainAccess(account, domain, { write: true })`) returns a Google
  consent URL, and `/api/searchconsole/callback` (GET) is hit by GOOGLE's redirect with NO API key
  and NO cookie. The callback therefore SKIPS `authorize()` (the same pattern `pages/api/adwords.ts`
  uses for its GET-with-code callback) and is NOT in `allowedApiRoutes.ts`. Do not add it; whitelisting
  a route the callback bypasses would be cargo-culting.
- Security is re-established by a SIGNED state: `/connect` signs a compact state (HMAC-SHA256 of the
  domain + owner id + nonce + timestamp, keyed by the app SECRET) in `utils/searchConsoleOAuth.ts`.
  `/callback` re-verifies that signature (constant-time compare, 15-minute TTL) before trusting the
  domain/owner. The state carries NO secret. The refresh token (the actual secret) is exchanged
  server-side and stored cryptr-encrypted on the owned Domain's `search_console` blob under
  `oauth_refresh_token`, scoped to `{ domain, owner_id }` from the verified state, so a forged state
  for a domain you do not own resolves to no row and stores nothing.
- The SC read path (`utils/searchConsole.ts`) prefers the OAuth refresh token (build an
  `OAuth2Client`, `setCredentials({ refresh_token })`) and falls back to the service-account JWT when
  there is none. Keep that fallback: it is the back-compat path for the env/service-account setup.
- The two OAuth env vars are `GSC_OAUTH_CLIENT_ID` / `GSC_OAUTH_CLIENT_SECRET`; the redirect URI is
  `${NEXT_PUBLIC_APP_URL}/api/searchconsole/callback`. If they are unset, `/connect` returns a
  friendly "not configured" message, it does not crash.

### No server-side LLM, ever (a verified-true trust property)
- The AI features (`briefing`, `insights`, `ai_visibility`, `alerts`, `entry_pages`) are
  RULES-BASED. They return structured data for the USER's own LLM to narrate. s33k has no
  model-training pipeline and calls no model provider. This is documented in `SECURITY.md` and
  answerable live via the `security_facts` tool. Keep this structurally true: no LLM client, no
  model-provider SDK, no train/embed/fine-tune path.

### Billing is per-unit ($7/site), not tiered
- The model is PER-UNIT, NOT named tiers. $7 per SITE per month, each site includes 50 keywords
  (`KEYWORDS_PER_SITE`), rank checks are WEEKLY for everyone (`WEEKLY_CADENCE_DAYS = 7`, the COGS
  lever). ONE recurring Stripe price (`STRIPE_PRICE_PER_SITE`); the subscription QUANTITY is the
  number of sites, stored on `account.paid_sites`. Adding a site is just quantity + 1.
- `utils/plans.ts` is the single source of truth: `capsForSites(sites)` derives caps, `resolveCaps`
  returns `capsForSites(TRIAL_SITES)` (1 site / 50 kw) while trialing, `capsForSites(paid_sites||1)`
  when active, very-high unlimited caps when MULTI_TENANT is off / admin, and `LOCKED_CAPS` otherwise.
  `isAccountActive` is unchanged (trialing-not-expired or active; flag-off + admin always active).
- A 14-day NO-credit-card trial = 1 site + 50 keywords, started ONLY in `invite/accept.ts`
  (acceptExternal). No card until the user runs Checkout. The webhook reads
  `subscription.items.data[0].quantity` into `paid_sites`; there is no price->tier reverse map.
- The legacy `account.plan` column is UNUSED by billing (left in place, harmless). Status still
  returns `plan: 'admin'` for the single-tenant sentinel so the UI hides its billing notice.

### Settings + the failed-retry queue are POSTGRES-BACKED, not files (A11, 2026-06-19)
- `data/settings.json` is RETIRED. Instance settings now live in ONE global Postgres row, the
  `setting` table (id = 1), via `utils/settingsStore.ts` (`getStoredSettings` / `writeStoredSettings`).
  The encrypted blob shape is byte-for-byte what settings.json held (sensitive fields still cryptr-
  encrypted). WHY one global row and not per-tenant: the OPERATOR runs the SERP scraper / SMTP /
  integrations, so this is admin-only instance config, not tenant data. On first read, the store does
  a ONE-TIME, race-safe (findOrCreate on id=1) import of an existing `data/settings.json` to preserve
  any UI-entered credentials, then the row is authoritative and the file is never read again. The
  three readers (`pages/api/settings.ts`, `utils/searchConsole.ts`, `utils/adwords.ts` +
  `pages/api/adwords.ts`) all go through the store; no app path touches settings.json.
- `data/failed_queue.json` is RETIRED. The retry queue is DERIVED from `keyword.lastUpdateError`
  (refresh.ts already sets it on a failed scrape, clears it to 'false' on success). `failedRetryWhere()`
  / `getFailedRetryKeywordIds()` in `utils/scraper.ts` are the query; `retryScrape` /
  `removeFromRetryQueue` are now exported NO-OPS kept for call-site compatibility. The hourly retry
  is `POST /api/cron?mode=retry` (DB-backed, tenant-scoped, same Bearer auth + spend-brake as the full
  scrape). `clearfailed` resets lastUpdateError to 'false' instead of writing a file.
- `cron.js` is now a THIN, FILE-FREE, ENV-CONFIGURED scheduler: it reads NO files. Cadences come from
  `SCRAPE_INTERVAL` (default weekly) and `NOTIFICATION_INTERVAL` (default never); the server owns all
  DB state and decides whether to actually scrape/notify. The hourly tick POSTs `/api/cron?mode=retry`.

### Conventions
- No em dashes (U+2014) ANYWHERE: prose, copy, code, labels, comments. Self-check: grep for the
  U+2014 character, count must be zero. Use `.` `,` `:` `·` or `/` instead.
- Max line 150 in code (`eslint max-len` fails the build otherwise). Prose in this file is exempt
  from the line cap but still no em dashes.
- Secrets come from `process.env` only, never hardcoded.
- `npx jest --ci` for one-shot test runs.
- All changes are ADDITIVE and FLAG-GATED. Do not regress the single-tenant / flag-off path.

---

## C. Commenting + decision-capture standard (Ben asked for this explicitly)

- **Comment the WHY and the non-obvious gotcha, not the what.** The code already says what it does.
- **Keep comments from going stale.** Only comment things unlikely to drift, or that are
  load-bearing. A stale comment is worse than none.
- **Intent lives in three places, each scoped to its reach:**
  - **Inline why-comments** · line-level, for the local gotcha.
  - **Commit messages** · why THIS change exists.
  - **This CLAUDE.md + BUILD_PLAN.md** · cross-cutting decisions and gotchas that span files.
- **When you hit a hard-won lesson, add it here** so it is never relearned. That is the whole point
  of this file.

---

## D. Hosted HTTP MCP endpoint (`pages/api/mcp`) and its key-isolation crux

- **What it is.** A remote MCP endpoint at `/api/mcp` (Streamable HTTP, SDK
  `StreamableHTTPServerTransport`). A client connects with a URL + a Bearer key and NO local install:
  `claude mcp add --transport http s33k <base-url>/api/mcp --header "Authorization: Bearer <key>"`.
  It exposes the SAME 82 tools as the stdio server via the shared `mcp/src/tools.ts`.
- **THE SECURITY CRUX (do not regress).** The route reads `Authorization: Bearer <key>` off the
  incoming request and binds a per-request fetchImpl to THAT key. Every tool call therefore hits the
  real s33k REST API carrying ONLY the connecting client's key, never `process.env.APIKEY` or any
  admin key. The API's `authorize()` then does all the scoping, so a scoped share key over the hosted
  MCP is held to GET-only + the per-domain allowlist + its one domain, identical to a direct REST
  call. No-Bearer is rejected 401 before any MCP server is built. If you ever touch this route, the
  only acceptable design is: a connection uses NOTHING but its own key. Proof: `__tests__/pages/
  hosted-mcp-scope.test.ts` drives a real in-memory client and asserts allow/deny using the PRODUCTION
  gate (`isScopedKeyAllowedRoute`).
- **Stateless on purpose.** A fresh McpServer + transport + key-bound fetch are built PER REQUEST
  (`sessionIdGenerator: undefined`) and closed on `res.on('close')`. This makes cross-connection key
  leakage structurally impossible. Do not switch to a shared/long-lived session without re-proving
  isolation.
- **The route is NOT in `allowedApiRoutes.ts`.** It does not call `authorize()` itself (it is the MCP
  transport, guarded by requiring a Bearer key); the scope check happens when its tools call the real
  `/api/*` routes, which DO go through `authorize()`. Do not whitelist `/api/mcp` there.
- **The loopback base URL is HEADER-INDEPENDENT, always `http://127.0.0.1:${PORT}` (do not regress).**
  `resolveBaseUrl()` in this route takes NO request and never reads `x-forwarded-host`/`host`. An
  earlier version derived the base from request headers when `NEXT_PUBLIC_APP_URL` was unset; a forged
  `X-Forwarded-Host` would then redirect the loopback fetch (which carries the CONNECTING CLIENT'S
  Bearer key) to an attacker host = key exfiltration + SSRF. The API we proxy is always THIS local
  process, so there is never a reason to consult headers. Keep it header-free. (The separate
  `utils/baseUrl.ts` resolver keeps its header logic on purpose: it builds USER-FACING share/invite
  links, not a key-bearing loopback.) Caught by the pre-launch adversarial review, 2026-06-18.
- **Per-key rate brake.** The handler runs `rateLimit('mcp:'+bearer, { limit: 240, windowMs: 60000 })`
  AFTER the no-Bearer 401 (so anonymous floods take the cheaper rejection) and before building the
  server, so one leaked/runaway key cannot fan out unbounded loopback work. Reuses `utils/rate-limit.ts`
  (its global ceiling also bounds a unique-key flood). 429 + Retry-After when exhausted.
- **Build-toolchain lesson (hard-won).** The hosted route pulls `zod` (via tools.ts) into the Next
  type-check. Root TypeScript was **4.8.4**, which cannot PARSE zod 3.25's `const`-type-param `.d.cts`
  (a syntax error `skipLibCheck` does not suppress). Bumping to TS **5.9** type-checked but OOM'd the
  build at the 4GB default heap. The durable fix shipped: pin root TS to **~5.4.5** (the same version
  the mcp workspace uses) AND set `NODE_OPTIONS=--max-old-space-size=8192` in the root `build` script.
  Do not bump root TS to 5.9+ casually; do not drop the heap bump. The mcp workspace keeps its own TS.
- **jest:** `modulePathIgnorePatterns: ['<rootDir>/.next/']` was added so the standalone build copy
  (`.next/standalone/mcp/package.json`) does not collide with `mcp/package.json` in jest-haste-map.
- **Importing the shared module into Next.** `pages/api/mcp` imports `../../../mcp/src/tools` even
  though root tsconfig EXCLUDES `mcp/`. exclude only drops files from the default include glob, not
  from import resolution, so webpack bundles it. The SDK `.js` ESM subpaths resolve via its `exports`
  `./*` wildcard; the eslint import resolver does not understand the wildcard, hence the two
  `eslint-disable import/extensions, import/no-unresolved` lines on the SDK imports. Keep them.

---

## E. The Tyler review gate (a mandatory checkpoint before EVERY deploy)

EVERY `railway up` passes through this gate. It is unconditional as a CHECKPOINT and triaging in
what it does. This is a standing rule for every session (Claude or Codex): apply it automatically,
do not wait to be asked. The mechanical gate (green tests) is necessary but not sufficient.

**When it fires:** before EVERY `railway up`, after the mechanical gate (lint + jest + build) is
green. Triage the change first (`git diff --name-only <base>..HEAD` or the working tree):
- Any path in the TRIGGER SURFACE below, OR any non-trivial change -> run the FULL CTO-grade
  adversarial review, and GATE the deploy on the verdict (clean ships; a must-fix gets fixed and
  RE-reviewed before shipping).
- Clearly trivial (doc / copy / test-only / dependency bump) -> log a one-line "review skipped:
  trivial" and proceed. When unsure, review. Never skip silently.

(If a full review on literally every deploy is wanted regardless of cost, drop the trivial-skip
branch. The triage exists only so a typo fix does not burn a 2-to-3-minute CTO pass.)

**Trigger surface (any of these = review required):**
- Auth + multi-tenant isolation: `utils/authorize.ts`, `utils/resolveAccount.ts`, `utils/scope.ts`,
  `utils/domain-access.ts`, `utils/canonical-domain.ts`, `utils/allowedApiRoutes.ts`.
- Billing: `pages/api/billing/*`, `utils/stripe.ts`, `utils/plans.ts`.
- Any new PUBLIC or authed API route, the hosted MCP route, or the invite/share/accept mint paths.
- Database migrations, and anything that reads/writes credentials or secrets.
- Product-fact claims in docs / `utils/knowledge.ts` / marketing copy (the stale-claim catch).

**What SKIPS it:** trivial UI/copy/doc/label changes, test-only edits, dependency bumps. Do not burn a
CTO review on those.

**How to invoke:** the `tyler-cto-advisor` agent (Agent tool, `subagent_type: tyler-cto-advisor`) for
the CTO-lens architecture/security read, or a `general-purpose` adversarial security reviewer for a
pure exploit pass. For multi-agent orchestrated builds, make the review a built-in PHASE between build
and deploy so a risky change structurally cannot ship unreviewed. Tell the reviewer to RUN the gate
itself and READ the code, then return a prioritized must-fix / should-fix / leave-it verdict.

Why: this codebase ships fast via many AI agents, so the mechanical gate (green tests) is necessary
but not sufficient on the surfaces where a subtle defect is a cross-tenant leak, a billing forge, or a
data-loss migration. The adversarial review is what has repeatedly caught exactly those classes.

---

## Quick map

- `database/database.ts`, `database/config.js` · Postgres-or-SQLite selection via `DATABASE_URL`.
- `utils/authorize.ts`, `utils/scope.ts` · the multi-tenant auth + scoping seam.
- `utils/allowedApiRoutes.ts` · API-route whitelist (keep dependency-free).
- `utils/knowledge.ts` · single source of truth for tool docs; the coverage test gates it.
- `mcp/src/tools.ts` · the SHARED MCP tool + resource registration (82 + 5). `mcp/src/index.ts` is
  the stdio entry; `pages/api/mcp/[[...slug]].ts` is the hosted HTTP endpoint. Both call into tools.ts.
- `SECURITY.md` · the verifiable trust facts (no-training, isolation, export/delete, cookieless).
- `BUILD_PLAN.md` · the phased plan + decision log. `NIGHT_REPORT.md` · the build-session log.
