# Go-live runbook: taking s33k multi-tenant

The operational checklist for opening s33k to real invited users (signup + magic-link
login). This is a CHECKLIST, not background reading. Work it top to bottom.

The code is built, tested, and deployed. What remains is configuration + a smoke test.

---

## Current prod state (verified 2026-06-19)

| Item | State | Note |
|---|---|---|
| `MULTI_TENANT` | **`true` (already on)** | The multi-tenant system + the `/api/auth/*` magic-link routes are LIVE right now, not dormant. The legacy `APIKEY` still resolves to admin, so admin/MCP access is unchanged. |
| `Account.email` migration | **applied** | Boot is fail-loud; the app is Online serving, so the additive `email` column applied cleanly. |
| `NEXT_PUBLIC_APP_URL` | **set** (`https://s33k-production.up.railway.app`) | Magic-link and invite links are built from this, so they point at the right host. |
| `RESEND_API_KEY` | **NOT set** | THE blocker. With it unset, `sendInviteEmail` / `sendMagicLinkEmail` skip the send. Invite + magic-link routes still return success (by design, non-leak), but no email is ever delivered, so a user can never complete login. |
| Railway plan | **Free, at the resource ceiling** | The current single instance is fine. Provisioning anything new (extra replicas, a Redis, etc.) is blocked until you upgrade. |

Net: the system is on, but **email is the missing wire.** Set `RESEND_API_KEY` and the loop closes.

---

## Pre-flight (do these before inviting a real user)

1. **Set `RESEND_API_KEY`** on the `s33k` Railway service. This is the one hard blocker.
   `railway variables --set "RESEND_API_KEY=<key>" --service s33k` then redeploy (`railway up`).
2. **Verify the sending domain in Resend.** The default sender is `s33k <noreply@invites.s33k.io>`.
   Either verify `invites.s33k.io` in your Resend account, OR set `RESEND_FROM_EMAIL` to an
   address on a domain you have already verified there. An unverified domain = Resend rejects the send.
3. **Stay on ONE instance.** Do NOT enable horizontal scaling / multiple replicas yet. The rate
   limiters (per-IP and the per-email inbox-bomb cap on `/api/auth/request-link`) are in-process, so
   N replicas means N times the intended ceiling. The per-email cap is the only inbox-flood defense,
   so a single instance is required until the shared-store limiter (the standing debt below) is built.
4. **Upgrade Railway only if you expect signup volume.** A handful of invited friends is fine on the
   current box. Real onboarding load needs headroom (and you cannot add a Redis for the limiter fix
   on the Free plan anyway).

---

## Go-live: smoke-test the whole loop with your OWN email first

Run this end to end before sending a real invite. `APIKEY` below is the admin Bearer key
(the legacy `process.env.APIKEY`).

1. **Send yourself an external invite** (as admin):
   `POST /api/invite` with `{ "type": "external", "email": "<your-test-email>" }` and
   `Authorization: Bearer <APIKEY>`. Expect `{ code, link, emailSent: true }`. Check the inbox: the
   branded invite email should arrive (this confirms Resend works).
2. **Accept it.** Open the `link` (or `/auth/login` style accept page). You get a NEW account on a
   14-day trial, an admin API key shown ONCE, and the MCP connect command. Save that key.
3. **Simulate a new device, request a magic link:**
   `POST /api/auth/request-link` with `{ "email": "<your-test-email>" }` (no auth). Expect
   `{ sent: true }`. The login email should arrive within seconds.
4. **Click the link.** It opens `/auth/login?token=...`, auto-verifies, and shows a FRESH admin key
   (the old one still works, gradual rotation). Logging in from a new device now works.
5. **Prove isolation.** With the new tenant's key, list domains (`GET /api/domains`). It must return
   ONLY that tenant's domains, NEVER the admin's (getmasset.com). If it sees admin data, STOP and do
   not invite anyone.
6. **Prove the non-leak.** `POST /api/auth/request-link` with an email that has NO account. It must
   return the identical `{ sent: true }` and send nothing. Same response = no enumeration.
7. **Confirm admin is unaffected.** The legacy `APIKEY` still has full admin access; the MCP banner
   is healthy; getmasset.com data is intact.

If all seven pass, you can send a real external invite.

---

## Verify (after a real user is on)

- The invited user can connect their LLM over MCP with their key and see only their own site.
- They can re-authenticate from a second machine via magic link.
- `external_invite_quota` (default 5 per account) gates how many external accounts the admin can
  invite. Raise the `account.external_invite_quota` column to grow it.
- Billing is deferred: every new account is a 14-day no-card trial. No Stripe charge wires up yet.

---

## Rollback (if something is wrong)

Set `MULTI_TENANT=false` on the `s33k` service and redeploy. This returns the instance to
byte-for-byte single-admin: the `/api/auth/*` routes 404, and per-account resolution stops (only the
legacy `APIKEY` + admin work). CAVEAT: any per-account or share key you have already handed out
(e.g. a teammate's read-only getmasset.com key) STOPS resolving while the flag is off. So only roll
all the way back if you have not onboarded real tenants yet; otherwise fix forward.

---

## Standing debt to schedule (not blocking V1)

- **Shared-store rate limiter.** The in-memory per-IP/per-email limiters live in ~5 places (the
  hosted MCP route, waitlist, collect, and both `/api/auth/*` routes). They are per-process. Build a
  single Postgres- or Redis-backed fixed-window limiter once and route all of them through it; only
  then is horizontal scaling safe. Until then: one instance.
- **Email-collision orphan.** If two external invites use the same email, the second account is
  created WITHOUT an email (so it can never magic-link login; it can be re-invited). A working key
  beats a 500, which is why it degrades this way. Surface a hint to that account in a later pass.

---

## Quick reference

| Action | Where |
|---|---|
| The flag | `MULTI_TENANT=true` on the `s33k` Railway service (already set) |
| Email wire | `RESEND_API_KEY` (+ a verified `RESEND_FROM_EMAIL` domain) |
| Link host | `NEXT_PUBLIC_APP_URL` (already set) |
| Invite (admin) | `POST /api/invite { type, email }` |
| Accept (public) | `POST /api/invite/accept { code }` |
| Request login link (public) | `POST /api/auth/request-link { email }` |
| Verify login link (public) | `POST /api/auth/verify-link { token }` |
| Login page | `/auth/login` (and `/auth/login?token=...`) |
| Isolation seam | `utils/authorize.ts` -> `resolveAccount` -> `scopeWhere` (see `CLAUDE.md` section B) |
