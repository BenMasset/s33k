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
- **MCP server:** `cd mcp && npm run build`, then probe over a real stdio handshake. 47 tools + 5
  resources today. Banner reads "47 tools and 5 resources registered." Smoke harness: `npm run smoke`
  from `mcp/`.
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
- Tools are registered in `mcp/src/index.ts` (47 tools + 5 resources today).
- Whitelist any new authed API route in `utils/allowedApiRoutes.ts`. Keep that file
  DEPENDENCY-FREE: no DB-model imports. Importing a model drags sequelize/uuid ESM into jest and
  breaks suites. That exact regression happened and was fixed. Do not reintroduce it.

### Model column names must match the migration EXACTLY (Postgres is case-sensitive)
- A new model used `field: 'id'` (lowercase) while its create-table migration keyed the column `ID`.
  On SQLite (case-insensitive) it worked; on Postgres `"id"` != `"ID"`, so every read of that model
  threw "column does not exist" and the route returned a generic 400. Rule: the model attribute's
  column name (the `field:` if set, else the attribute name) must byte-match the column the
  migration creates. Also register every new model in `database/database.ts`'s `models` array, and
  remember migrations run on boot via `entrypoint.sh` (`sequelize-cli db:migrate`), which does NOT
  exit on failure, so a broken migration lets the server boot with a missing/mismatched table.

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

### No server-side LLM, ever (a verified-true trust property)
- The AI features (`briefing`, `insights`, `ai_visibility`, `alerts`, `entry_pages`) are
  RULES-BASED. They return structured data for the USER's own LLM to narrate. s33k has no
  model-training pipeline and calls no model provider. This is documented in `SECURITY.md` and
  answerable live via the `security_facts` tool. Keep this structurally true: no LLM client, no
  model-provider SDK, no train/embed/fine-tune path.

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

## Quick map

- `database/database.ts`, `database/config.js` · Postgres-or-SQLite selection via `DATABASE_URL`.
- `utils/authorize.ts`, `utils/scope.ts` · the multi-tenant auth + scoping seam.
- `utils/allowedApiRoutes.ts` · API-route whitelist (keep dependency-free).
- `utils/knowledge.ts` · single source of truth for tool docs; the coverage test gates it.
- `mcp/src/index.ts` · MCP tool + resource registration (40 + 5).
- `SECURITY.md` · the verifiable trust facts (no-training, isolation, export/delete, cookieless).
- `BUILD_PLAN.md` · the phased plan + decision log. `NIGHT_REPORT.md` · the build-session log.
