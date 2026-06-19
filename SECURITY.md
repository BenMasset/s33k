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

## 2. Tenant isolation (one account can never see another's data)

Every tenant-owned table carries an `owner_id`, and every read, create, and delete
runs through one scoping helper, `scopeWhere(account)` / `ownerIdFor(account)` in
`utils/scope.ts`. A real tenant's query always gets `{ owner_id: <their account ID> }`
injected into its where-clause, so a tenant can only ever touch its own rows. (In the
default single-tenant / admin mode the scope is empty by design, which is what keeps a
self-hosted single-owner install simple.)

This is proven by adversarial tests, not just asserted:

- `__tests__/pages/route-scope-isolation.test.ts`: asserts that a real tenant read
  carries `{ owner_id: TENANT.ID }`, that creates **stamp** the right `owner_id`, and
  that deletes are scoped the same way. A regression that drops `scopeWhere` from a
  query loses `owner_id` and this test fails.
- `__tests__/pages/account-routes-isolation.test.ts`: asserts that a tenant minting
  or revoking a key for **another** account is refused and the model is never written,
  and that admin-only routes 403 a non-admin tenant.
- `__tests__/utils/scope.test.ts`, `__tests__/utils/lodd-domain-scope.test.ts`,
  `__tests__/utils/authorize-tenant-resolution.test.ts`: cover the scoping helper and
  tenant resolution directly.

The same pattern guards every data route: each one calls `authorize()` and then
verifies domain ownership with `Domain.findOne({ where: { domain, ...scopeWhere(account) } })`
before returning anything (see `pages/api/briefing.ts`, `insights.ts`, `insight.ts`,
`ai-visibility.ts`, `domains.ts`).

---

## 3. Encryption at rest (your connected credentials are encrypted)

The only secrets s33k stores are the credentials you connect: Google Search Console
keys, Google Ads keys, and the SERP scraper key. They are encrypted at rest with
[`cryptr`](https://www.npmjs.com/package/cryptr) (AES-256) keyed by the app `SECRET`
environment variable. They are decrypted only in memory, only to make the API call
they belong to, and are never logged, never returned by the export endpoint, and never
sent to a model.

Where to verify:

- `pages/api/domains.ts` and `pages/api/settings.ts`: `cryptr.encrypt(...)` on write
  for `client_email`, `private_key`, `scaping_api` (scraper key), `smtp_password`, and
  the `adwords_*` credentials.
- `utils/searchConsole.ts` and `utils/adwords.ts`: encryption-at-rest markers and
  `cryptr.decrypt(...)` on read, in memory only.

API keys are stored as a SHA-256 `key_hash`, never as the clear key. The full key is
shown exactly once, at mint time, and cannot be recovered afterward.

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
| Tenant isolation | `__tests__/pages/route-scope-isolation.test.ts`, `__tests__/pages/account-routes-isolation.test.ts`, `__tests__/utils/scope.test.ts`, `utils/scope.ts` |
| Encryption at rest | `pages/api/domains.ts`, `pages/api/settings.ts`, `utils/searchConsole.ts`, `utils/adwords.ts` |
| Data export | `pages/api/export.ts`, MCP `export_data` |
| Hard delete | `pages/api/account-data.ts`, MCP `delete_account_data` |
| Cookieless / no-PII tracking | `public/s33k.js`, `pages/api/collect.ts`, `utils/event-sanitize.ts` |
| Open source / self-hostable | the repository itself |

Ask your LLM the `security_facts` MCP tool for any of these and it will answer with the
fact and where to verify it.
