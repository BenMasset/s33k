---
name: s33k-review-gate
description: Recurring patterns the s33k Tyler-gate review checks, and what has shipped clean vs been caught
metadata:
  type: project
---

s33k (`/Users/ben/Projects/s33k`) runs a mandatory CTO review gate before every `railway up` (repo `CLAUDE.md` section E). I am that gate.

**Why:** s33k ships fast via parallel AI agents; green tests are necessary but not sufficient. The high-value defect classes on this codebase are cross-tenant leaks, auth/scope gaps, data-loss migrations, and stale product-fact claims.

**How to apply (the load-bearing checks, in order):**
- Multi-tenant scoping: every per-domain route must `authorize()` then spread `scopeWhere(account)` into EVERY query, and gate ownership via `resolveDomainAccess(account, domain)` (returns null = deny, treat as 403) BEFORE any read. The `domain` column is globally `@Unique`, so by-domain scoping cannot leak across tenants.
- Scoped SHARE keys: enforced in `utils/authorize.ts` lines ~44-55. A share key is allowed ONLY when method is GET + route is in `scopedKeyAllowedRoutes` + canonical `?domain=` equals canonical `scoped_domain`. A missing/empty domain canonicalizes to `''` and is DENIED. This means any "no-domain / list-my-domains" branch in a route is structurally unreachable for a share key. New authed routes need entries in BOTH `allowedApiRoutes` and (if share-key-safe) `scopedKeyAllowedRoutes`.
- A not-owned domain answered as a generic 200 (instead of 403) is safe IFF no tenant data is read on that path (counts guarded by `owned ?`) and the response is identical for "does not exist" vs "owned by another tenant" (no existence oracle). `start_here` does this correctly.
- MCP tool count integrity: runtime banner is computed `70 + adminToolsRegistered` (NOT hardcoded total). Customer tools register via `server.registerTool` directly (in the 70 base); admin tools via `registerAdminTool`/`countingRegister`. New tool must touch: `mcp/src/tools.ts`, `utils/knowledge.ts` (knowledge-coverage jest guard parses tools.ts and FAILS the build if missing), `mcp/smoke-test.mjs` EXPECTED_TOOLS, `__tests__/pages/hosted-mcp-scope.test.ts` count. The coverage guard has no hardcoded total, so the count cannot silently rot, but doc quick-map lines (CLAUDE.md / AGENTS.md) DO go stale and are a recurring should-fix.
- SSRF (`utils/site-crawl.ts`): the pinned-dispatcher pattern must hand back ONLY the single pre-vetted IP for BOTH dns.lookup callback shapes (`{all:true}` array form and 3-arg form), and `safeFetchText` must re-validate + re-pin + close the dispatcher PER redirect hop. Verify the rebinding property survives any edit here.
- Em dashes: grep U+2014, count must be zero, everywhere including code/comments.

**2026-06-19 review (`s33k-tyler-followups`):** SSRF lookup-shape fix + new `start_here` MCP tool (82 total / 70 customer) + setup-checklist dedup (`computeSetupState` now shared). Verdict SHIP. Only findings: two stale `(81 + 5)` quick-map lines in CLAUDE.md:312 and AGENTS.md:150 (cosmetic). Gate green on Node 20: lint clean, mcp build clean, Next "Compiled successfully", 1156/1156 jest.

See [[project_s33k_codebase_review]] for the original V1 codebase review.
