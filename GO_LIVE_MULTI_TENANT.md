# Go-live runbook: taking s33k public (invite-only, trial + Stripe)

The operational checklist for opening s33k to real users. This is a CHECKLIST, not background
reading. Work it top to bottom. Launch model (locked by Ben): INVITE-ONLY funnel. Every invited
user gets a 14-day, 1-site, no-card trial, then hits a hard pay wall and subscribes via Stripe at
$7/site/month. Public self-serve signup is BUILT but intentionally dormant (the s33k.io landing
stays "request access"); flip it later by pointing the landing form at `/api/signup`.

---

## What changed this session (the launch-hardening, all committed on `main`, NOT yet deployed)

| Area | State | Where |
|---|---|---|
| Tenant data isolation | An operator (you) CANNOT read any tenant's data via any app/API/MCP path with the flag on. Account login emails encrypted at rest (AES-256) with a keyed HMAC blind index. | `utils/scope.ts`, `utils/accountEmail.ts`, migration 027. Tyler: SHIP. |
| Scale to ~1000 users | Shared-store (Postgres) rate limiter behind `RATE_LIMIT_BACKEND`; atomic transactional billing caps (no count-then-create race); `DB_POOL_MAX`; scale indexes (migration 030); bounded scrape concurrency; resumable paged cron drain (no keyword starvation); bulk ingest. | `utils/rate-limit*.ts`, `utils/caps-guard.ts`, `utils/scrape-queue.ts`, `pages/api/cron.ts`. Tyler: SHIP. |
| Self-serve signup | Public `/api/signup` (email-verified magic link, non-enumerating, rate-limited, 404 when flag off). BUILT but the public landing does NOT point at it yet (invite-only choice). | `pages/api/signup.ts`, `/signup` page. |
| Automatic Stripe lifecycle | trial -> wall -> checkout -> unlock -> cancel/relock, all webhook-driven and idempotent. In-LLM billing tools (`billing_status`, `start_checkout`, `open_billing_portal`). Dunning emails. | `pages/api/billing/*`, `mcp/src/tools.ts`. Tyler: FIX-THEN-SHIP, fixes applied. |
| Branding + UX | De-SerpBeared UI; `/welcome` post-checkout page; discoverable login; `BACKUP.md`. | many. Tyler: SHIP. |

Gate at every round: lint clean, full jest green (now 160 suites / 1394 tests), next + mcp builds green, zero em dashes.

---

## Step 0: deploy the hardened build (NOTHING above is live yet)

`main` is **+6 commits ahead of `origin/main`** and ahead of what is running on Railway. The hardening
is committed locally only.

1. **Push `main` to origin FIRST.** Deploy is `railway up` from the working tree, but a later
   *variable-change* redeploy rebuilds from the **pinned git origin**. If origin is stale, changing any
   env var will silently REVERT all six hardening commits (documented footgun). So: `git push origin main`
   before you touch any Railway variable.
2. **Deploy:** from `~/Projects/s33k` (NOT a sibling dir), `railway up --service s33k`. This runs
   migrations 027/029/030 on boot (fail-loud; the next boot is the migration checkpoint).
3. Confirm the app is Online and `GET /api/summary` returns the new shape (has `humanVisitors`).

---

## Step 1: set the env (single instance, billing on)

Set these on the `s33k` Railway service, then redeploy (origin already pushed per Step 0):

| Var | Set to | Why |
|---|---|---|
| `MULTI_TENANT` | `true` | already on. Tenants + `/api/auth/*` + signup live. |
| `NEXT_PUBLIC_APP_URL` | `https://app.s33k.io` | already set. Magic-link / checkout-redirect base (header-poison-proof). |
| `RESEND_API_KEY` | already set + WORKING | invite/login/dunning email. Do NOT re-debug (blank in `railway variables --kv` is a reference-var CLI artifact). |
| `STRIPE_SECRET_KEY` | your **test** key first (`sk_test_...`), then live | enables checkout/portal. Unset = pay wall returns 503 (graceful). |
| `STRIPE_PRICE_PER_SITE` | the recurring $7/site Price id | the per-unit price bought with quantity = sites. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` from the Stripe webhook endpoint | verifies webhook signatures (forged = 400, mutate nothing). |
| `RATE_LIMIT_BACKEND` | leave UNSET (`memory`) | correct for ONE instance. Only set `postgres` for multi-instance, AND only after verifying the Postgres `ON CONFLICT RETURNING` path against real PG (should-fix #1 below). |
| `DB_POOL_MAX`, `SCRAPE_CONCURRENCY`, `CRON_PAGE_SIZE`, `LAST_USED_THROTTLE_MS` | leave unset | defaults (5 / 10 / 500 / 5min) are right at launch scale. |
| `WAITLIST_ALLOWED_ORIGINS` | include `https://s33k.io,https://www.s33k.io` | CORS for the landing's request-access (and signup, if opened later). |

Stay on ONE Railway instance until the shared-store limiter is verified on real PG (see should-fix #1).

---

## Step 2: configure Stripe (test mode first)

1. In Stripe (TEST mode): create ONE recurring Product/Price, $7 / site / month; copy the Price id ->
   `STRIPE_PRICE_PER_SITE`.
2. Add a webhook endpoint -> `https://app.s33k.io/api/billing/webhook`, subscribed to:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`,
   `customer.subscription.trial_will_end`. Copy the signing secret -> `STRIPE_WEBHOOK_SECRET`.
3. Enable the Stripe Billing Portal (Settings -> Billing -> Customer portal).
4. Use the test key (`sk_test_...`) for the smoke test in Step 4; swap to live only after it passes.

---

## Step 3: smoke-test the invite + login + isolation loop (your OWN email)

`APIKEY` = the admin Bearer key (legacy `process.env.APIKEY`).

1. **Invite yourself:** `POST /api/invite` `{ "type":"external", "email":"<you>" }`, `Authorization: Bearer <APIKEY>`. Expect `{ code, link, emailSent:true }`; the branded invite email arrives.
2. **Accept** the link -> NEW account on a 14-day trial, admin key shown ONCE, MCP connect command. Save the key.
3. **Magic-link from a "new device":** `POST /api/auth/request-link` `{ "email":"<you>" }` (no auth) -> `{ sent:true }`, login email arrives.
4. **Click it** -> `/auth/login?token=...` auto-verifies, shows a FRESH key (old one still works).
5. **Prove isolation:** with the new tenant key, `GET /api/domains` returns ONLY that tenant's domains, NEVER getmasset.com. If it sees admin data, STOP.
6. **Prove non-leak:** `POST /api/auth/request-link` for an email with NO account -> identical `{ sent:true }`, nothing sent.
7. **Admin unaffected:** legacy `APIKEY` still full admin; MCP banner healthy; getmasset.com intact.

---

## Step 4: smoke-test the FULL Stripe billing loop (test mode, your trial account)

Do this with `STRIPE_SECRET_KEY=sk_test_...`. Use Stripe test card `4242 4242 4242 4242`.

1. **In-LLM status:** from an MCP client on the trial account's key, call `billing_status` -> trialing, N days left, 1 site.
2. **Force the wall:** either wait out the trial or set the account's `trial_ends_at` to the past in the DB (test only). Now a WRITE (`POST /api/keywords` / `onboard`) must 403 with the "trial ended / call billing_status then start_checkout" message; reads still work.
3. **Checkout:** call `start_checkout { sites: 1 }` -> hosted Stripe URL. Pay with the test card. You land on `/welcome?billing=success`.
4. **Auto-unlock:** the `checkout.session.completed` + `customer.subscription.*` webhooks flip the account to `active`. Re-run the write from step 2: it now succeeds. `billing_status` shows active, 1 paid site.
5. **Add a site:** `start_checkout { sites: 2 }` (or change quantity in the portal) -> `customer.subscription.updated` -> `paid_sites` = 2, caps follow.
6. **Payment fail -> relock:** in Stripe test, trigger a failed renewal (or send a test `invoice.payment_failed`). Account -> `past_due` = locked immediately (writes 403, scraping paused); the dunning email fires. Then a successful `invoice.payment_succeeded` -> `active` = auto-unlock.
7. **Cancel -> relock:** cancel in the portal -> `customer.subscription.deleted` -> `canceled` = writes 403 again; reads still work.
8. **Forged webhook:** POST a body with a bad/missing signature -> 400, account state UNCHANGED.

If all eight pass on test mode, swap `STRIPE_SECRET_KEY` (and the webhook endpoint's secret) to LIVE and you can invite real users.

---

## Step 5: durability before inviting paying users

- Enable Railway automated Postgres backups on the `s33k` Postgres service (daily, retain 7+ days; confirm one snapshot exists). See `BACKUP.md` section 1. No API, dashboard only.
- Run the `BACKUP.md` restore drill once so backups are proven restorable, not just present.

---

## Rollback

Set `MULTI_TENANT=false` on `s33k` and redeploy: byte-for-byte single-admin (the `/api/auth/*` and
`/api/signup` routes 404, per-account resolution stops, only legacy `APIKEY`/admin work). CAVEAT: any
per-account / share key already handed out STOPS resolving while off. So only full-rollback if no real
tenant is onboarded; otherwise fix forward.

---

## Should-fix to schedule (not blocking invite-only, single-instance V1)

- **#1 Verify the Postgres rate-limiter `ON CONFLICT ... RETURNING` path against real Postgres BEFORE
  setting `RATE_LIMIT_BACKEND=postgres`.** The shared-store limiter is built and unit-tested on the
  SQLite branch only; the PG path is unexercised (the same test-path-vs-prod-path trap that hid the
  VARCHAR + UmamiProvider bugs). It is DORMANT on the `memory` default, which is correct for one
  instance. Required only when scaling to multiple replicas.
- **Equalize signup/request-link awaited work** to close the residual email-existence timing oracle
  (low signal; the 3/hour-per-email + 10/min-per-IP caps make it impractical). Do it once for both routes.
- **Concurrent-duplicate-signup orphan account** (a racing second signup on the same new email leaves a
  null-email trialing account). DB litter, no money/data leak. Follow-up.
- **past_due grace window** (currently sites lock the instant a payment fails). The eager lock is the
  safe default; add an explicit active-through-grace predicate only if you want a dunning window.

---

## Quick reference

| Action | Where |
|---|---|
| The flag | `MULTI_TENANT=true` on the `s33k` Railway service |
| Deploy | `git push origin main` THEN `railway up --service s33k` from `~/Projects/s33k` |
| Stripe price / key / webhook | `STRIPE_PRICE_PER_SITE` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` |
| Invite (admin) | `POST /api/invite { type, email }` |
| Request login link (public) | `POST /api/auth/request-link { email }` |
| In-LLM billing | MCP tools `billing_status`, `start_checkout`, `open_billing_portal` |
| Backups | `BACKUP.md` (Railway dashboard, daily, 7+ day retention) |
| Isolation seam | `utils/authorize.ts` -> `resolveAccount` -> `scopeWhere` (see `CLAUDE.md` section B) |
| Open self-serve later | point the s33k.io landing form at `/api/signup` (built, dormant) |
