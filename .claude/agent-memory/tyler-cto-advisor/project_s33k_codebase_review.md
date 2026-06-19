---
name: s33k-codebase-review
description: CTO-level code review of s33k (2026-06-19) — isolation seam quality, open risks, fork debt; what to re-check next time
metadata:
  type: project
---

CTO review of s33k done 2026-06-19 on branch state with 1145 passing tests, lint clean, root build + mcp build green (82 MCP tools).

**Verdict: sound tool, trustworthy for friends-sign-up scale after a short must-fix list. Not yet "thousands of untrusted tenants" hardened.**

**What is genuinely well-built (do not touch):**
- The multi-tenant isolation seam: `utils/scope.ts`, `utils/authorize.ts`, `utils/domain-access.ts`, `utils/canonical-domain.ts`, `utils/allowedApiRoutes.ts`. Positive allowlist for share keys (not blacklist-by-presence), canonical-domain compare on both gate and DB lookup, scoped keys stripped of admin identity via a Symbol marker, GET-only enforcement. The canonical-domain leak class was found and closed by adversarial review.
- Hosted MCP route (`pages/api/mcp/[[...slug]].ts`): per-request stateless server, key-bound loopback fetch, header-independent base URL (closes the X-Forwarded-Host key-exfil/SSRF), per-key rate brake, no-bearer 401.
- Stripe webhook (`pages/api/billing/webhook.ts`): raw-body signature verify, idempotent set-to-target updates, MAX_SITES re-clamp defense in depth, account resolution by metadata then customer id.
- Invite/share mint-on-accept (`pages/api/invite/accept.ts`): atomic claimInvite (conditional UPDATE guarded by status='pending' = TOCTOU-safe), keys stored hash+prefix only, generic-reject everywhere (no enumeration).
- No server-side LLM is structurally true: zero LLM SDK in package.json; the "anthropic"/"gpt-" grep hits are user-agent classifier strings only.
- Migration discipline: the swallow-and-continue data-loss class is fixed. VARCHAR(255)->TEXT widen migration (`...012`) and billing-columns migration (`...024`) both FAIL LOUD on a real error, only swallow idempotency.

**Stale-doc finding (Tyler-catch):** CLAUDE.md section "Model column names" says `set -e` was deliberately NOT added so a failed migration still boots. The actual `entrypoint.sh` now does `npx sequelize-cli db:migrate || exit 1` (refuse to boot on migration failure). The fix is correct; the doc is stale and contradicts it. Flag for correction.

**Must-fix-before-scale (multi-tenant blind spots, NOT current leaks):**
1. File-backed GLOBAL state under `data/`: `settings.json` (scraper key, SMTP, SC service-account, Google Ads creds, all cryptr-encrypted) and `failed_queue.json` (`utils/scraper.ts`), and `result.txt` debug dump. These are INSTANCE-level, admin-gated (verifyUser), not tenant-scoped. Acknowledged in audit A11/A4. Fine for single-admin + invite-only friends; a real liability once untrusted tenants share the instance (one global scraper config, one global failed queue). This is the riskiest inherited SerpBear debt.
2. `pages/api/keywords.ts` getKeywords queries `{ domain: req.query.domain }` RAW (line 63), while authorize() gates on the CANONICAL form. A non-canonical variant ("WWW.example.com") passes the gate then matches no canonically-stored row = fail-CLOSED (returns empty), not a leak. Still an inconsistency: same raw-vs-canonical divergence the leak fix killed elsewhere. Should resolve off the owned canonical domain like domains.ts/share.ts do.

**Fork debt (should-fix):** dual searchConsole files (service-account JWT + OAuth), inherited `cron.js` separate process reading file state, legacy verifyUser routes (settings/clearfailed/ideas/adwords/dbmigrate/logout) audited and fenced out of both API allowlists by guard tests. `any` still common in MCP handlers + scraper (audit A15 open). `mcp/src/tools.ts` is 3099 lines / 82 registerTool blocks in one file — flat and consistent but big; maintainable now, will want splitting by pillar before it doubles.

**Calibration:** the disagreement (Ben's "let's try anyway" over my multi-week estimate) is a clear WIN. The fast-AI-build adversarial-review discipline (build via parallel agents, then 5-agent / 4-agent sweeps) caught exactly the high-value defects: canonical-domain cross-tenant leak, migration data-loss, no-op metrics. The highest-value-defect classes I predicted (migration data-loss, tenant leaks, honesty bugs) were the ones the reviews actually found and fixed. The code earns trust because it was adversarially reviewed, not because it was written carefully the first time.

**Re-check next time:** whether the multi-tenant flag has actually been flipped on in prod (review was flag-off byte-for-byte path); whether file-backed global state got moved to owner-scoped DB rows; the tenant model decision (still the one open product-shape gate).
