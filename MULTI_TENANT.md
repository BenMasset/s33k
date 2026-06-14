# s33k Multi-Tenant Foundation (Plan + Recommended First Schema)

This is a planning document plus the recommended first schema for turning s33k from
its inherited single-admin SerpBear shape into a hosted, multi-account product. It is
NOT implemented in this phase. It is written to be pragmatic, incremental, and above
all non-breaking: every step below leaves the current single-tenant admin path and the
running app working exactly as they do today, with no data migration that can lose or
corrupt existing rows.

The guiding constraint: s33k stays 100% MCP-controllable. Multi-tenancy must be
expressible through the Bearer API key (each account gets its own key) so the product
works headless with no UI, which is how it works today.

---

## 1. Where s33k is today (the single-tenant reality)

s33k is a fork of `towfiqi/serpbear`. Its auth and ownership model is the SerpBear
model, which is single-admin and entirely environment-variable driven. There is no
users table and no accounts table.

**Auth surfaces today:**

- **UI login** (`pages/api/login.ts`): compares the posted `username`/`password`
  against `process.env.USER_NAME` (or `USER`) and `process.env.PASSWORD`. On success
  it signs a JWT with `process.env.SECRET` and sets it as the `token` cookie. The JWT
  payload is just `{ user: userName }`. There is exactly one user.
- **Bearer API key** (`utils/verifyUser.ts`): a single shared key,
  `process.env.APIKEY`. Any request whose `Authorization: Bearer <key>` equals
  `APIKEY` is authorized, but only for an explicit whitelist of routes
  (`allowedApiRoutes`). The MCP server (`mcp/src/index.ts`) authenticates every tool
  call with this one key.
- `process.env.SECRET` is also the Cryptr encryption key for stored secrets (Search
  Console service-account JSON in `domain.search_console`, ads tokens in settings).

**Data model today** (`database/models/`):

- `Domain` (`tableName: 'domain'`): integer autoincrement PK `ID`, unique `domain`
  string, unique `slug`. No owner column. `timestamps: false`.
- `Keyword` (`tableName: 'keyword'`): integer autoincrement PK `ID`. It does NOT have
  a real foreign key to `Domain`. Instead it carries a `domain` STRING column and is
  joined by domain name (the `@ForeignKey`/`@BelongsTo` decorators are commented out
  in the model). `timestamps: false`.
- `crawlerHit` (`tableName`): per-domain AI-crawler hits, also joined by domain
  string.

**How rows are fetched today** (the scoping seam we will exploit):

- `getDomains` does `Domain.findAll()` with no `where`.
- Keyword routes do `Keyword.findAll({ where: { domain } })` keyed on the domain name
  string, not on any owner.

So the entire codebase already funnels reads and writes through a small number of
`findAll` / `bulkCreate` / `update` calls. That is the seam. Multi-tenancy is a matter
of adding a nullable `owner_id` to those models and threading the caller's account into
those same calls. We do not need to rearchitect the data layer.

**Migration runner today** (`pages/api/dbmigrate.ts`): Umzug v3 over
`database/migrations/*.js` with `SequelizeStorage`. Migrations are written to support
both the Umzug v3 single-arg `{ context }` convention AND the classic sequelize-cli
positional `(queryInterface, Sequelize)` convention (see the `resolveQueryInterface`
helper in `1749801600000-add-keyword-target-page-field.js`). New migrations must follow
that exact dual-convention pattern. Migrations run as additive `addColumn` calls inside
a transaction, guarded by a `describeTable` existence check so they are idempotent.

DB is SQLite today (`./data/database.sqlite`). The roadmap (BUILD_PLAN.md) is to move
s33k's own DB to the same Postgres that hosts Umami. The schema below is written so it
works on both SQLite and Postgres without change.

---

## 2. Design principles

1. **Nullable owner, default to the legacy admin.** Every new ownership column is
   `allowNull: true` with no default. A NULL `owner_id` means "the original
   single-tenant admin." Existing rows get NULL and keep working. The code treats
   "the admin account" and "NULL owner" as the same thing during the transition.
2. **Additive migrations only.** No column is dropped, renamed, or made `NOT NULL` in
   the first wave. No data is moved. Backfill is optional and idempotent.
3. **One scoping function, threaded everywhere.** Introduce a single
   `scopeWhere(account)` helper that returns `{}` for the admin/legacy path and
   `{ owner_id: account.id }` for a real tenant. Drop it into the existing `findAll` /
   `update` / `destroy` calls. The blast radius is small because all access already
   goes through a handful of calls.
4. **The API key is the tenant boundary.** Each account gets its own Bearer key. The
   key resolves to an account; the account scopes the query. This keeps the product
   MCP-controllable: a tenant points their MCP server at their own key and sees only
   their data.
5. **Feature-flag the whole thing.** A single env flag (`MULTI_TENANT=true`) turns
   tenant resolution on. When off (the default), the app behaves byte-for-byte like
   today: `APIKEY` works, `USER_NAME`/`PASSWORD` log in, every query is unscoped. This
   lets us ship the schema and the code before we ship the product, with zero risk to
   the running instance.
6. **No secret in a committed file, ever.** Account API keys are stored hashed (see
   below). The legacy `APIKEY` stays in `.env` and is never committed.

---

## 3. Recommended first schema

Two new tables. Both `timestamps: true` (these are the first tables where created/updated
matter for a hosted product). New nullable columns on the two existing data tables. No
changes to `crawlerHit` in wave 1 (it inherits scoping through its domain, see 5.3).

### 3.1 `account` table

The billing/ownership unit. In the common case one account == one company == one human,
but the model allows many users per account later.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `ID` | INTEGER | no | autoincrement PK | matches the `ID` convention used by `domain`/`keyword`. |
| `name` | STRING | yes | `''` | display name, e.g. "Masset". |
| `plan` | STRING | yes | `'free'` | `free` / `pro` / etc. Not enforced in wave 1, just carried. |
| `status` | STRING | yes | `'active'` | `active` / `suspended`. Suspended accounts fail auth. |
| `created_at` | DATE | yes | now | sequelize timestamps. |
| `updated_at` | DATE | yes | now | sequelize timestamps. |

**Seed row:** migration inserts exactly one account, `ID = 1`, `name = 'Admin'`,
`plan = 'admin'`. This is the home for the legacy single-tenant data. NULL `owner_id`
and `owner_id = 1` are treated as equivalent by the scoping helper, so we never have to
backfill existing `domain`/`keyword` rows to make them work. (An optional, idempotent
backfill that sets the existing NULLs to `1` can run later once we are confident, but it
is not required for correctness.)

### 3.2 `api_key` table

One account can have many keys (rotation, separate keys per MCP client). A key maps to
exactly one account.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `ID` | INTEGER | no | autoincrement PK | |
| `account_id` | INTEGER | no | | FK to `account.ID` (logical FK; see 3.4 on enforcement). |
| `name` | STRING | yes | `''` | human label, e.g. "Ben's laptop MCP". |
| `key_prefix` | STRING | no | | first ~8 chars of the key, stored in clear, for lookup + display (`s33k_ab12cd34...`). |
| `key_hash` | STRING | no | | SHA-256 (or bcrypt/argon2) of the full key. The full key is shown ONCE at creation and never stored. |
| `last_used_at` | DATE | yes | null | observability. |
| `revoked_at` | DATE | yes | null | non-null means dead. |
| `created_at` | DATE | yes | now | |
| `updated_at` | DATE | yes | now | |

**Key format:** `s33k_<random>` (e.g. 32 bytes base62). Lookup is by `key_prefix`
(indexed), then verify the hash. Storing only the hash means a leaked DB dump does not
leak usable keys, and we never put a real key in a committed file.

### 3.3 New columns on existing data tables

Added by additive migration, all nullable, no default that changes existing behavior.

`domain` table:

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `owner_id` | INTEGER | yes | null | FK to `account.ID`. NULL == legacy admin. |

`keyword` table:

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `owner_id` | INTEGER | yes | null | FK to `account.ID`. NULL == legacy admin. Denormalized onto keyword so keyword queries can scope without a join, matching the existing "join by string, no real FK" pattern. |

Note: keyword already carries a `domain` STRING and no real FK, so denormalizing
`owner_id` onto keyword is consistent with how the fork already works and keeps the
existing `Keyword.findAll({ where: { domain } })` calls a one-line change to
`{ domain, ...scopeWhere(account) }`.

### 3.4 FK enforcement

Keep FKs **logical, not database-enforced** in wave 1. The existing models use
`timestamps: false` and string joins with no real FKs; adding hard FK constraints via
SQLite migration is fragile (SQLite cannot add a constraint to an existing table without
a table rebuild). So `owner_id` is a plain indexed INTEGER column that points at
`account.ID` by convention. When s33k moves to Postgres (roadmap), wave 2 can add the
real FK constraints cleanly. Add an index on `domain.owner_id` and `keyword.owner_id`
for scoped queries.

---

## 4. How the API key maps to an account

This is the heart of staying MCP-controllable.

**Today:** `verifyUser` returns the string `'authorized'` when `Bearer <key> == APIKEY`.
The caller has no identity beyond "the admin."

**Target:** `verifyUser` (or a thin wrapper) resolves the Bearer key to an account and
returns that account (or a sentinel admin account). Concretely:

1. Extract the Bearer token.
2. If `MULTI_TENANT` is off OR the token equals the legacy `process.env.APIKEY`:
   return the **admin account** (NULL/`ID=1`). This is the back-compat branch. The
   legacy key keeps working forever.
3. Otherwise, look up the token: take its prefix, `SELECT * FROM api_key WHERE
   key_prefix = ? AND revoked_at IS NULL`, verify the hash, load the joined `account`,
   check `account.status = 'active'`. On success return that account; update
   `last_used_at`. On failure return the existing `'Invalid API Key Provided.'` error.

The route-whitelist logic in `verifyUser` is unchanged: API callers (tenant or admin)
can still only reach the whitelisted routes. New account/key-management routes get added
to that whitelist (see 6) so they too are Bearer-reachable.

**Return-shape compatibility:** `verifyUser` currently returns a `string`. To avoid
touching every caller at once, the safest incremental move is to keep `verifyUser`
returning its string verdict and add a sibling `resolveAccount(req, res)` that returns
`{ authorized: boolean, account: Account | null, error?: string }`. Routes adopt
`resolveAccount` one at a time. Until a route adopts it, it behaves exactly as today
(admin-scoped, i.e. unscoped). This is the incrementality lever: we can convert routes
to tenant-aware one PR at a time, and an un-converted route is simply admin-only, which
is the current behavior.

**UI login (cookie/JWT) path:** unchanged in wave 1. The JWT still signs
`{ user: userName }`. Wave 2 adds `{ user, account_id }` to the JWT payload once there
is a real users table and a signup flow; until then the cookie session is the admin
account.

---

## 5. Per-request scoping

### 5.1 The scoping helper

```ts
// utils/scope.ts (illustrative, not implemented this phase)
export const ADMIN_ACCOUNT_ID = 1;

// Returns a Sequelize `where` fragment that limits rows to the caller's account.
// Admin/legacy callers get {} (no restriction) so existing data with NULL owner_id
// stays fully visible, preserving today's behavior.
export function scopeWhere(account: Account | null): Record<string, unknown> {
  if (!account || account.ID === ADMIN_ACCOUNT_ID) return {};
  return { owner_id: account.ID };
}
```

Reads merge it into the existing `where`:

```ts
const allDomains = await Domain.findAll({ where: { ...scopeWhere(account) } });
const keywords  = await Keyword.findAll({ where: { domain, ...scopeWhere(account) } });
```

Writes stamp the owner:

```ts
domainsToAdd.push({ domain, slug, owner_id: account?.ID ?? null, /* ... */ });
```

Updates/deletes add the scope to the `where` so a tenant can never mutate another
tenant's row even if they guess an `ID`:

```ts
await Keyword.update(payload, { where: { ID, ...scopeWhere(account) } });
await Domain.destroy({ where: { ID, ...scopeWhere(account) } });
```

### 5.2 Why this is non-breaking

- For the admin/legacy caller, `scopeWhere` returns `{}`, so every query is identical to
  today. Existing rows (NULL `owner_id`) are fully visible.
- For a new tenant, only their rows match. Their newly created rows get their
  `owner_id`. They cannot see or touch the admin's data or each other's.
- No existing row is ever rewritten by the schema change itself.

### 5.3 Scoping the derived/analytics surfaces

The analytics, scoreboard, AI-referral, insight, and crawler routes do not own their own
tenant data in wave 1: they read from the configured analytics provider (Lodd/Umami) and
join to `keyword`/`domain`. Scope them through the domain: resolve the requested domain,
confirm it belongs to the caller via `scopeWhere`, and only then run the provider call.
The provider site id (`LODD_SITE`, Umami website id) is still env-level in wave 1, which
is fine while there is effectively one real tenant. Wave 2 moves the provider site id and
the analytics credentials onto the `domain` (or `account`) row so each tenant points at
their own Umami website. This also closes the known gap that the Lodd provider reads a
fixed `LODD_SITE` regardless of domain: in the multi-tenant world the site id comes from
the domain row, not the env.

`crawlerHit` needs no new column in wave 1 because it is always queried by domain, and
the domain is already owner-scoped. If we later expose cross-domain crawler reads, add an
`owner_id` to `crawlerHit` the same additive way.

---

## 6. New MCP tools and routes (keep it 100% MCP-controllable)

Because each account is created and keyed through the API, the account lifecycle must be
reachable over the Bearer key, following the exact existing tool pattern in
`mcp/src/index.ts` and whitelisting each new route in `utils/verifyUser.ts`.

Recommended new admin-only routes/tools (callable only with the legacy admin key, or a
key whose account has an `admin` plan):

| Route | Method | MCP tool | Purpose |
|---|---|---|---|
| `/api/accounts` | POST | `create_account` | Create an account. Returns the account id. |
| `/api/accounts` | GET | `list_accounts` | List accounts (admin only). |
| `/api/account-keys` | POST | `create_api_key` | Mint a key for an account. Returns the full key ONCE. |
| `/api/account-keys` | DELETE | `revoke_api_key` | Revoke a key (sets `revoked_at`). |
| `/api/account-keys` | GET | `list_api_keys` | List keys for an account (prefix + metadata only, never the secret). |

Self-service tools callable by any tenant key (scoped to their own account):

| Route | Method | MCP tool | Purpose |
|---|---|---|---|
| `/api/me` | GET | `whoami` | Returns the caller's account (id, name, plan). Useful sanity check for MCP clients. |
| `/api/account-keys/rotate` | POST | `rotate_api_key` | Rotate the caller's own key. |

All new routes get added to `allowedApiRoutes` in `verifyUser.ts` so they are
Bearer-reachable. The mint-key response is the only place a full key is ever returned,
and it is never persisted in clear and never written to a committed file.

---

## 7. Migration path (the order of operations)

Each step is its own migration file under `database/migrations/`, named with the
`<epoch>-<description>.js` convention, written in the dual-convention
(`resolveQueryInterface`) idempotent style already in the repo, additive only, inside a
transaction, guarded by `describeTable`. Migrations run through the existing
`/api/dbmigrate` Umzug runner with no runner changes.

**Wave 1 (ship the foundation, product still single-tenant in practice):**

1. `create-account-table.js`: create `account`; insert the single admin row (`ID=1`).
   Idempotent: skip create if table exists, skip insert if `ID=1` exists.
2. `create-api-key-table.js`: create `api_key` with the index on `key_prefix`.
3. `add-owner-id-to-domain.js`: `addColumn('domain', 'owner_id', { INTEGER, allowNull: true })`
   + index. No backfill needed (NULL == admin).
4. `add-owner-id-to-keyword.js`: same for `keyword` + index.
5. Code: add `Account` and `ApiKey` models, `utils/scope.ts`, and `resolveAccount`
   alongside the existing `verifyUser`. Ship behind `MULTI_TENANT` (default off). With
   the flag off, none of the new scoping runs and the app is byte-for-byte today's app.

At the end of wave 1 the schema exists, the admin path is untouched, and nothing is
tenant-scoped yet. This is a safe, shippable checkpoint.

**Wave 2 (turn it on, route by route):**

6. Convert routes to `resolveAccount` + `scopeWhere`, one PR per route group
   (domains, keywords, then the analytics/derived routes). Each conversion is
   independently testable; an unconverted route stays admin-only.
7. Add the account/key MCP tools and routes (section 6).
8. Move the analytics provider site id + credentials from env onto the `domain` row so
   each tenant points at their own Umami website (also closes the fixed-`LODD_SITE`
   gap).
9. Flip `MULTI_TENANT=true` in the hosted environment.

**Wave 3 (hardening, post-Postgres move):**

10. Add a real users table + signup/login, put `account_id` in the session JWT, and
    move UI auth off the single `USER_NAME`/`PASSWORD` env pair.
11. Once on Postgres, add database-enforced FK constraints on `owner_id` columns.
12. Optional idempotent backfill: set NULL `owner_id` rows to `1` and make `owner_id`
    `NOT NULL`, only after every read/write path is confirmed scoped.

### 7.1 Rollback safety

Every wave-1 migration has a `down` that drops only what it added (the new tables and the
two `owner_id` columns), guarded by `describeTable`, exactly like the existing
`target_page` migration's `down`. Because wave 1 adds nothing required by old code and
moves no data, rolling back is a clean drop with no data loss. The `MULTI_TENANT` flag is
the faster rollback: turning it off reverts all behavior without a migration.

---

## 8. What this plan deliberately does NOT do (yet)

- No row-level encryption-per-tenant. `SECRET`/Cryptr stays global in wave 1.
- No per-tenant rate limiting, billing, or quota enforcement (`plan` is carried, not
  enforced).
- No users-within-account model or RBAC. One key == one account in wave 1; multiple
  keys per account are allowed but all have equal power within that account.
- No hard FK constraints until Postgres.
- No change to the UI login flow until wave 3.

These are intentional cuts to keep wave 1 small, additive, and non-breaking. They are
listed so the next builder knows they were considered, not forgotten.

---

## 9. Summary

The fork already funnels all data access through a few `findAll`/`bulkCreate`/`update`
calls and already authenticates the entire product through one Bearer key. That makes
multi-tenancy a small, additive change rather than a rearchitecture:

1. Two new tables (`account`, `api_key`) and two nullable `owner_id` columns.
2. One scoping helper threaded into the existing queries.
3. One key-to-account resolver alongside the existing `verifyUser`.
4. A feature flag so the foundation ships dark and the running single-tenant app is
   never at risk.

NULL `owner_id` plus a seeded admin account means the existing data and the existing
admin Bearer key keep working with zero migration of existing rows, and the product
stays fully MCP-controllable because every account gets its own key.
