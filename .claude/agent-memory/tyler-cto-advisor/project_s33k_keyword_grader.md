---
name: s33k-keyword-grader
description: 2026-06-23 CTO review of the deterministic onboarding keyword grader (utils/keyword-grader.ts); verdict SHIP, two should-fixes
metadata:
  type: project
---

s33k onboarding got a DETERMINISTIC keyword-quality grader (`utils/keyword-grader.ts`, Rubric 1 from
keyword_grading.md) to strip nav/doc-chrome junk ("agents", "all guides", "knowledge base") from
Firecrawl's raw candidates before tracking. NO LLM, NO new API key (Ben explicitly refuses a Claude
key here). Firecrawl's own LLM generates candidates; a new `/scrape` (8 pillar pages, concurrent with
`/extract`, bounded by SCRAPE_TEXT_CAP=6000) feeds the grader the page text; the grader scores 1-100
across G1-G6 and keeps passers (gate default 60, env `KEYWORD_GRADE_GATE`).

**Reviewed 2026-06-23. Verdict: SHIP.** Gate green (lint clean, 39 feature tests pass Node 20). Never
throws (I stress-tested empty/whitespace/CJK/5000-char/null/numeric/malformed-URL inputs: zero throws).
Hard cap works (G1<=2 -> capped 35, fails gate). Fallback chain sound: grade -> top-ranked -> ungraded
-> heuristic; onboarding can never 500 or end empty from grading; COGS allowance clamp still respected
(runs AFTER grading on `selected`, scopeWhere-scoped). Flag-off/single-tenant untouched. No host/secret
leak (all 7 Firecrawl error strings are generic constants; grader is pure text + one env read).

**Two should-fixes (logged, not blocking an English-market launch):**
1. **Non-latin keywords silently dropped.** `norm()` strips everything outside `[a-z0-9\s&-]`, so
   CJK/Cyrillic/Greek candidates normalize to empty and are filtered by the `key.length>=2` guard.
   A non-English site's candidates can mostly vanish; if ALL vanish, `usedFirecrawl` is already true
   so it does NOT fall back to heuristic, it lands on the "could not auto-detect" note. Graceful, not
   a crash, hence not a blocker. Fix for intl: widen norm to keep Unicode letters, OR fall through to
   heuristic when graded empties out.
2. **Scrape/extract evidence mismatch.** Extract POSTs 15 URLs (MAX_PILLAR_URLS) but only 8 are
   scraped (MAX_SCRAPE_PAGES), so a candidate the LLM drew from page 9-15 can be hard-capped as a
   relevance-orphan purely because that page wasn't scraped. Small in practice (shallow-first ordering
   puts real pillars in the top 8). Align the two or document the intent.

**Gotcha for the deploy:** the grader + its test are NEW UNTRACKED files (not in `git diff`). `railway
up` uploads the working tree so they ship, but the COMMIT must `git add` them or the next session loses
the code and onboarding reverts to ungraded.

Pattern reinforced (4th-ish straight s33k gate): the adversarial pass finds a quiet uncovered input
class (here: non-latin) that degrades gracefully rather than crashes. Keep running the gate on every
parallel-agent build. See [[s33k-review-gate]].
