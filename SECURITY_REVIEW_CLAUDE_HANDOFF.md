# s33k Security Review Handoff

Static security/code review only. No files were edited during the audit itself, and no migrations,
tests, lint, or build commands were run.

## Executive Summary

- Critical: none found in static review.
- Highest risk: SSRF remains possible through crawler/citability fetches despite hostname filtering.
- Highest cost risk: tenant admins can add unowned, unlimited keywords and trigger scrapes.
- Trust gap: export/delete does not include all account-linked data.
- Multi-tenant isolation is broadly solid, but there are a few important exceptions.

## Findings

### Critical

None found in static review.

### High

#### 1. SSRF guard is bypassable in server-side crawling

Locations:

- `utils/site-crawl.ts:80`
- `utils/site-crawl.ts:118`
- `pages/api/discover.ts:40`
- `pages/api/onboard.ts:79`

`utils/site-crawl.ts` blocks many private hosts, but it misses normalized IPv4-mapped IPv6
private/link-local forms, does not resolve DNS before fetching, and follows redirects without
revalidating the destination. A tenant-controlled domain/onboard/discover path can make the server
fetch internal or metadata addresses.

Impact:

- A tenant with API access may be able to make the server fetch private network or cloud metadata
  endpoints.
- The current guard is useful, but not complete enough for untrusted server-side URL fetching.

Recommended fix:

- Validate create/onboard domains before any crawl path can use them.
- Resolve A/AAAA records and reject private, loopback, link-local, reserved, and metadata ranges.
- Handle redirects manually and re-check every `Location` before following.
- Explicitly block IPv4-mapped IPv6 private/link-local addresses after URL normalization.
- Consider outbound egress firewalling for defense in depth.

#### 2. `POST /api/keywords` allows unowned domains and unbounded cost-bearing work

Locations:

- `pages/api/keywords.ts:81`
- `utils/allowedApiRoutes.ts:15`
- `pages/api/refresh.ts:60`
- `pages/api/cron.ts:34`
- `utils/domains.ts:19`

`POST /api/keywords` stamps the caller owner id but does not verify that each submitted keyword
domain belongs to the caller before bulk create and immediate refresh. The route is API-key
whitelisted, and refresh/cron paths can perform cost-bearing SERP and Google Ads work.

Impact:

- A tenant admin can add keywords for arbitrary domains, including another tenant's domain string.
- The tenant cannot directly read another tenant's rows, but can burn operator SERP/Ads quota.
- Because `utils/domains.ts` aggregates keyword stats by domain without owner scope, these unowned
  keyword rows can skew another tenant's domain stats.

Recommended fix:

- Group submitted keywords by domain and require scoped `Domain` ownership for every domain.
- Reject unknown or unowned domains before `bulkCreate`.
- Enforce per-account, per-domain, and per-request keyword caps.
- Add scrape budgets/cadence limits before any immediate refresh is queued.
- Dedupe submitted keywords before insert and refresh.

#### 3. Export/delete omits account-linked records

Locations:

- `pages/api/export.ts:83`
- `pages/api/account-data.ts:77`
- `database/models/invite.ts:25`
- `database/models/featureRequest.ts:25`
- `pages/api/invite/accept.ts:159`

Export and delete cover domains, keywords, events, crawler hits, API keys, and account metadata, but
do not include invites or feature requests. Those tables contain account-linked state. A deleted
account can also leave pending external invite codes usable by `pages/api/invite/accept.ts`.

Impact:

- The "export/delete everything s33k holds for the account" trust claim is not currently true.
- Pending external invites can outlive the inviter account and still create accounts.
- Feature request text/account metadata can remain after account deletion.

Recommended fix:

- Export invites where the account is inviter, target, or accepted-by.
- Export feature requests for `account_id` or `owner_id`.
- On account delete, delete or revoke invites tied to inviter, target, or accepted-by account ids.
- Delete feature request rows tied to the account.
- Add regression tests for export and hard-delete coverage.

### Medium

#### 4. Crawler-hit ingest is storage-abuse prone

Locations:

- `pages/api/crawler-hit.ts:28`
- `database/models/crawlerHit.ts:28`
- `utils/allowedApiRoutes.ts:34`

The crawler-hit route is authenticated and domain gated, but has no rate limit, row quota,
retention, dedupe, or path/user-agent length cap before writing TEXT fields.

Impact:

- An authenticated tenant can spam recognized crawler user agents and create unbounded rows.
- Large path/user-agent values can create avoidable storage and database pressure.

Recommended fix:

- Add per-account, per-domain, and per-IP throttles.
- Cap `path` and `userAgent` length.
- Add retention or rollup behavior.
- Consider feature-gating the route until the dormant feeder path is live.

#### 5. Unowned domain delete can remove Search Console cache

Locations:

- `pages/api/domains.ts:102`
- `utils/searchConsole.ts:277`

`DELETE /api/domains` scopes DB deletes correctly, but calls `removeLocalSCData(domain)` regardless
of whether a scoped domain row was actually deleted.

Impact:

- A tenant can request deletion of another tenant's domain string and remove
  `data/SC_<domain>.json` if it exists.

Recommended fix:

- Verify scoped ownership with `Domain.findOne({ domain, ...scopeWhere(account) })` first.
- Return 403 or 404 if not owned.
- Only call `removeLocalSCData` after a successful scoped domain delete.
- If local Search Console cache remains in multi-tenant mode, include tenant/account identity in the
  cache key.

#### 6. Security/help facts overstate current guarantees

Locations:

- `utils/securityFacts.ts:49`
- `utils/knowledge.ts:564`
- `utils/knowledge.ts:650`
- `database/models/crawlerHit.ts:28`

`securityFacts` says every tenant-owned table carries `owner_id`, but crawler hits do not. Knowledge
entries also claim keyword caps/scrape cadence controls that were not found in the unrestricted
keyword, refresh, or cron paths.

Impact:

- Users querying s33k over MCP can receive false assurances from the product's own self-docs.
- This is especially important because knowledge coverage tests ensure tool docs exist, but not that
  the claims are behaviorally true.

Recommended fix:

- Either implement the stated guarantees or rewrite the facts to match reality.
- Add tests that tie sensitive knowledge claims to real enforcement constants or route behavior.

#### 7. Google Ads OAuth callback has no `state`

Location:

- `pages/api/adwords.ts:15`

The Google Ads OAuth callback accepts a public `code` and writes global Ads credentials without
validating an OAuth `state` nonce.

Impact:

- Setup CSRF or credential poisoning may be possible if an attacker can produce a code for the same
  redirect URI/client.

Recommended fix:

- Bind the flow to a signed session nonce.
- Validate `state` before exchanging the code or writing settings.
- Prefer keeping the callback tied to an authenticated admin session.

### Low

#### 8. TEXT migration can silently succeed after partial failure

Location:

- `database/migrations/1750147200012-widen-string-columns-to-text.js:78`

The migration catches per-column `ALTER` errors and continues. Umzug may record the migration as
successful while important columns remain `VARCHAR(255)`.

Recommended fix:

- Attempt all columns, collect failures, and throw at the end if any critical column failed.
- Add a Postgres migration smoke test that verifies the final column types.

#### 9. Search Console legacy plaintext weakens the encryption-at-rest claim

Location:

- `utils/searchConsole.ts:199`

Search Console credentials are encrypted on new writes, but the read path accepts legacy plaintext
private keys containing `BEGIN PRIVATE KEY`.

Recommended fix:

- Re-encrypt legacy plaintext on read/write-back.
- Add a one-time migration or startup audit.
- Make the public trust claim precise if legacy plaintext support must remain.

#### 10. Scraper writes a production debug artifact

Location:

- `utils/scraper.ts:321`

`scrapeKeywordFromGoogle` writes `result.txt` on each scrape.

Recommended fix:

- Remove the write or gate it behind an explicit debug flag.

## Verified Good

- No runtime `require('./x').NamedExport` provider pattern was found in app/MCP runtime code.
- The Umami provider path is static-imported.
- No server-side LLM/provider SDK or model API call was found.
- AI-facing routes appear rules-based and use database/provider reads.
- Member API keys are centrally GET-only through `utils/authorize.ts`.
- Analytics routes generally gate domain ownership before provider/event reads.
- Public analytics collection is cookieless, DNT-aware, rate-limited, bot-filtered, and
  PII-sanitized.
- Export/delete scoping is strong for the tables it currently includes.
- The knowledge coverage gate is real and verifies MCP tools have knowledge entries.

## Recommended Test Additions

- SSRF tests for IPv4-mapped IPv6 private ranges, DNS-to-private, and redirect-to-private.
- Domain validation tests for create, onboard, discover, and citability fetch entry points.
- Route tests proving `POST /api/keywords` rejects unowned domains and over-budget batches.
- Refresh/cron tests for scrape budget and cadence enforcement.
- Export/delete tests covering invites, feature requests, and pending invite invalidation.
- Crawler-hit tests for rate limits, size caps, retention, and quotas.
- Domain-delete test proving unowned domains do not call `removeLocalSCData`.
- Postgres migration smoke tests proving widened columns are TEXT after migration.
- Standalone build smoke test for the Umami provider static import path.
- Knowledge accuracy tests for sensitive claims backed by enforcement constants or route behavior.

## Open Questions

- Should crawler hits get `owner_id`, or is global unique domain plus ownership gating the intended
  durable invariant?
- What are the intended keyword and scrape budget limits per account/domain/day?
- Should feature requests be treated as account export/delete data, product feedback retained after
  deletion, or both with explicit disclosure?
- Should pending invites be automatically revoked when the inviter account is deleted?

