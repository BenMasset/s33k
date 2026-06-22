# s33k Security and Trust

s33k is an open, self-hostable, MCP-controllable SEO + AEO + analytics suite. This
document is the honest, specific answer to one question: can a marketer start a free
trial with zero security fear? The answer rests on a simple principle.

**Verify us, don't trust us.** Every claim below points at the exact code, test, or
config that proves it. s33k is open source, so you can read all of it, and you can
self-host it so the data never leaves your own infrastructure.

A trial user can also ask their own LLM "is this safe? do you train on my data? who
else can see it?" and get these same answers back as structured facts: the
`security_facts` MCP tool returns this document's guarantees in machine-readable form.

---

## 1. We do not train on your data (this is structurally true)

s33k has **no model-training pipeline anywhere in the codebase**. There is no LLM
client, no embedding step, no fine-tuning job, and no code path that sends your data
to any model trainer. This is not a policy promise that could quietly change. It is a
structural fact about what the code can and cannot do.

The AI features (the daily briefing, the cross-pillar insights, the AI-visibility
funnel) are **rules-based**. They run small, transparent, commented rules over your
own data on the server and return a structured, narration-ready bundle. The
interpretation ("tell me what this means and what to do") happens in **your own LLM**,
over MCP. s33k only ever hands your LLM structured data that it computed from your
account. It never asks an external model anything about your data, and it never sends
your data to a model to be trained on.

Where to verify:

- `pages/api/briefing.ts`: top-of-file trust marker plus the long header comment:
  "This route is RULES-BASED. It does NOT call any LLM."
- `pages/api/insights.ts`: same trust marker and "RULES-BASED. It does NOT call any
  LLM" header.
- `pages/api/ai-visibility.ts`: trust marker; the view is built only from
  first-party AI referral traffic plus a deterministic on-page audit.
  "It NEVER queries an LLM."
- `mcp/src/index.ts`: the `briefing`, `insights`, and `ai_visibility` tool
  descriptions all state the s33k server does not call an LLM.

The distinction that matters: this is not "we don't train today." It is "we have no
infrastructure to train, and your data never leaves the server for any model."

---

## 2. Tenant isolation (one account can never see another's data, and neither can the operator)

Every tenant-owned table carries an `owner_id`, and every read, create, and delete
runs through one scoping helper, `scopeWhere(account)` / `ownerIdFor(account)` in
`utils/scope.ts`. A real tenant's query always gets `{ owner_id: <their account ID> }`
injected into its where-clause, so a tenant can only ever touch its own rows.

**The operator is a scoped tenant too (multi-tenant mode).** When `MULTI_TENANT` is on,
the seeded admin/operator account (ID 1) is NOT an unscoped master reader. It is scoped
to its OWN data, the legacy `owner_id IS NULL` partition (`scopeWhere` returns
`{ owner_id: IS NULL }` for the operator), so the operator's everyday admin key or cookie
cannot read any other tenant's domains, keywords, rankings, events, dashboards, or
reports through any API or MCP route. The operator keeps INSTANCE-admin powers (list
accounts, mint/revoke keys, read the waitlist, run the cron rank sweep), but those expose
account METADATA only, never tenant content. There is exactly ONE legitimate unscoped
read: the cron rank sweep, which must scan every tenant's keywords on the shared SERP
key. It does NOT go through `scopeWhere`; it uses a separate, named
`unscopedOperatorWhere()` at one call site (`pages/api/cron.ts`), gated on the operator,
and every such instance-wide access is recorded in the audit log (section 9).

**The single-tenant case.** When `MULTI_TENANT` is off (the default self-host),
`scopeWhere` returns `{}` for everyone, because there is one operator who legitimately
owns all the data. That is what keeps a self-hosted single-owner install simple and is
byte-for-byte the original behavior. The unscoped-`{}` path exists ONLY in this mode;
with the flag on, no account, including the operator, ever gets `{}` from `scopeWhere`.

This is proven by adversarial tests, not just asserted:

- `__tests__/utils/scope.test.ts`: asserts the operator/admin gets
  `{ owner_id: IS NULL }` (NOT `{}`) under `MULTI_TENANT` on, a real tenant gets its own
  `owner_id`, and the flag-off path still returns `{}` for every account shape.
- `__tests__/pages/operator-data-isolation.test.ts`: drives the operator's admin key in
  multi-tenant mode and asserts it is denied (403 / own-data-only) on another tenant's
  summary, dashboard, keywords, events, export, and domain list, while still reading its
  own null-owner data; the hosted-MCP path is covered the same way.
- `__tests__/pages/route-scope-isolation.test.ts`: asserts a real tenant read carries
  `{ owner_id: TENANT.ID }`, creates **stamp** the right `owner_id`, and deletes are
  scoped the same way.
- `__tests__/pages/account-routes-isolation.test.ts`: asserts a tenant minting or
  revoking a key for **another** account is refused and the model is never written, and
  that admin-only routes 403 a non-admin tenant.
- `__tests__/utils/lodd-domain-scope.test.ts`,
  `__tests__/utils/authorize-tenant-resolution.test.ts`: cover the scoping helper and
  tenant resolution directly.

The same pattern guards every data route: each one calls `authorize()` and then
verifies domain ownership with `Domain.findOne({ where: { domain, ...scopeWhere(account) } })`
before returning anything (see `pages/api/briefing.ts`, `insights.ts`, `insight.ts`,
`ai-visibility.ts`, `domains.ts`).

---

## 3. Encryption at rest (credentials and your login email are encrypted; the honest residual)

The credentials you connect (Google Search Console keys, Google Ads keys, the SERP
scraper key) are encrypted at rest with [`cryptr`](https://www.npmjs.com/package/cryptr)
(AES-256) keyed by the app `SECRET` environment variable. They are decrypted only in
memory, only to make the API call they belong to, and are never logged, never returned
by the export endpoint, and never sent to a model.

**Your login email is also encrypted at rest.** `account.email` (the magic-link login
key, and PII) is stored as cryptr ciphertext, not plaintext, so a database dump does not
expose login emails. Because the ciphertext is non-deterministic (cryptr uses a random
IV), the deterministic LOOKUP and uniqueness moved to a separate `account.email_hash`
column: a keyed `HMAC-SHA256(SECRET, normalized email)` blind index. Magic-link login and
signup dedupe query by that hash, so an attacker with a DB dump cannot brute-force the
small email space or build a rainbow table without also stealing `SECRET`.

API keys are stored as a SHA-256 `key_hash`, never as the clear key. The full key is
shown exactly once, at mint time, and cannot be recovered afterward.

Where to verify:

- `pages/api/domains.ts` and `pages/api/settings.ts`: `cryptr.encrypt(...)` on write
  for `client_email`, `private_key`, `scaping_api` (scraper key), `smtp_password`, and
  the `adwords_*` credentials.
- `utils/searchConsole.ts` and `utils/adwords.ts`: encryption-at-rest markers and
  `cryptr.decrypt(...)` on read, in memory only.
- `utils/accountEmail.ts`: `encryptEmail` / `decryptEmail` / `emailHash`, and the
  `1750147200027-encrypt-account-email.js` migration that encrypts existing rows and adds
  the `email_hash` unique index.

**The honest residual (what is NOT encrypted, and why).** Your analytics substrate, the
autocapture events (`S33kEvent`), the tracked keywords and their full rank history
(`Keyword`), the domain names (`Domain`), and the AI-crawler hits (`CrawlerHit`), is
stored in PLAINTEXT in the database. This is not an oversight: s33k computes analytics
over this data on the server (counts, sessions, rank trends, cross-pillar joins), so it
cannot be zero-knowledge or end-to-end encrypted, the server has to read it to do its
job. The practical consequence: anyone with physical access to the database or its
credentials (the hosting provider, the operator, a DB breach) can read this analytics
data. What is encrypted at rest is exactly the set that does NOT need to be computed
over: your connected third-party credentials and your login email. This is precisely why
self-hosting (section 5) is offered as the strongest guarantee: when you own the
deployment and the database, that residual access is yours alone.

---

## 4. Your data is yours (export it, or hard-delete it, on demand)

Ownership you can exercise, not just claim:

- **Export everything.** `GET /api/export` (MCP tool `export_data`) returns one JSON
  bundle with all of your data: domains, keywords with full rank history,
  autocapture events, and account + API-key metadata. It is tenant-scoped, so it only
  ever contains your own data. It **never** includes a secret: Search Console / Google
  Ads credentials are reported only as configured-or-not, and API keys come back as
  non-sensitive metadata (prefix, name, role, timestamps), never the key hash and never
  the clear key.
- **Hard-delete everything.** `DELETE /api/account-data` (MCP tool
  `delete_account_data`) permanently and irreversibly deletes your entire account and
  all of its data: every domain, keyword, and autocapture event, your API
  keys, your account row, and (best-effort) your per-domain Umami analytics websites. It
  is guarded three ways: it requires the exact confirmation `{ confirm: "DELETE" }` or
  it refuses and changes nothing; it is tenant-scoped so it can only ever delete your
  own data; and the root admin account can never be deleted this way. There is no undo.

Where to verify: `pages/api/export.ts`, `pages/api/account-data.ts`, and the
`export_data` / `delete_account_data` tools in `mcp/src/index.ts`.

---

## 5. Open source and self-hostable (verify us, don't trust us)

s33k is open source. You can read every line of the code that touches your data, and
you can run the whole thing on your own infrastructure with your own database, so your
data never leaves your control. Self-hosting is the strongest possible form of "verify,
don't trust": the guarantees in this document are things you can confirm by reading the
code and, if you self-host, by owning the deployment end to end.

---

## 6. Cookieless, no-PII tracking

The s33k autocapture script (`public/s33k.js`) and its ingest endpoint
(`pages/api/collect.ts`) are built to capture the **event, never the person**.

- **No cookies, no fingerprinting.** The session id lives in `sessionStorage` only and
  is a daily-rotating value: it cannot identify a person and cannot be joined across
  days or across tabs.
- **No typed content, ever.** The client never reads the value of an `input`,
  `textarea`, `select`, `[contenteditable]`, or any password field. It records THAT a
  form was submitted (its id/name), never the field values. Captured text is trimmed
  and length-capped; inputs are explicitly excluded.
- **Defense in depth on the server.** `pages/api/collect.ts` sanitizes every event and
  drops anything PII-shaped (an email, a card number, a value smuggled into a label)
  before it is stored. The ingest also enforces domain allow-listing, bot filtering,
  rate limiting, and tenant stamping (`owner_id` copied from the owning domain).

Where to verify: `public/s33k.js` (the PRIVACY header and the capture helpers),
`pages/api/collect.ts`, and `utils/event-sanitize.ts`.

---

## 7. Sub-processors

s33k uses a deliberately small set of sub-processors. When you self-host, the hosting
and database are yours, and Umami can be self-hosted alongside s33k.

| Sub-processor | Role | Notes |
|---|---|---|
| Railway | Hosting for the managed s33k service, plus its Postgres database | Self-hosters supply their own host and database (Postgres in prod, SQLite locally). |
| Umami (self-hosted) | Analytics collection substrate for page traffic | Open source (MIT). Per-domain websites are deleted on account hard-delete, best-effort. |
| Serper | SERP data for keyword rank tracking | The SERP query runs server-side on the s33k operator's key (`scrapers/services/serper.ts`); the scraper key is encrypted at rest. |

No customer data is sent to any LLM provider as a sub-processor, because s33k makes no
LLM calls. The analysis happens in **your** LLM, which is your client and your choice,
not a sub-processor of s33k.

---

## 8. The proof index

| Guarantee | Proven by |
|---|---|
| No model training / no LLM call | `pages/api/briefing.ts`, `insights.ts`, `ai-visibility.ts` trust markers; `mcp/src/index.ts` tool descriptions |
| Tenant isolation (incl. the operator) | `__tests__/pages/operator-data-isolation.test.ts`, `__tests__/pages/route-scope-isolation.test.ts`, `__tests__/pages/account-routes-isolation.test.ts`, `__tests__/utils/scope.test.ts`, `utils/scope.ts` |
| Encryption at rest (credentials + login email) | `pages/api/domains.ts`, `pages/api/settings.ts`, `utils/searchConsole.ts`, `utils/adwords.ts`, `utils/accountEmail.ts` |
| Privileged-access audit log | `database/models/auditLog.ts`, `utils/auditLog.ts`, `pages/api/audit-log.ts` |
| Data export | `pages/api/export.ts`, MCP `export_data` |
| Hard delete | `pages/api/account-data.ts`, MCP `delete_account_data` |
| Cookieless / no-PII tracking | `public/s33k.js`, `pages/api/collect.ts`, `utils/event-sanitize.ts` |
| Open source / self-hostable | the repository itself |

Ask your LLM the `security_facts` MCP tool for any of these and it will answer with the
fact and where to verify it.

---

## 9. Privileged-access audit log (multi-tenant mode)

In the hosted multi-tenant build, the operator is a scoped tenant for its own data
(section 2) but keeps INSTANCE-admin powers. Every privileged action, the cron rank
sweep across all tenants, listing or creating accounts, minting or revoking a key for
another account, reading the waitlist or feature requests, is recorded in an `audit_log`
table (metadata only: actor, action, target account/domain, route, time, never tenant
content and never secrets). The operator can read this trail at `GET /api/audit-log`
(admin-only). The writer (`utils/auditLog.ts`) is best-effort and never blocks a request,
and is a no-op when `MULTI_TENANT` is off, so a single-tenant install has an empty trail
and is unchanged.

Where to verify: `database/models/auditLog.ts`, `utils/auditLog.ts`,
`pages/api/audit-log.ts`, and the `recordAudit(...)` call sites in `pages/api/cron.ts`,
`account.ts`, `account-key.ts`, `waitlist.ts`, `feature-request.ts`.
