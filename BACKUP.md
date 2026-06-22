# s33k data durability: backup and restore

This is the single source of truth for backing up and restoring s33k's data on Railway. Production
runs on **Postgres** (`DATABASE_URL`), so every durability step below is about that Postgres database,
not a file or a volume. `DEPLOY.md` points here; do not duplicate this runbook elsewhere.

Two independent layers protect the data. Use both:

1. **Railway automated Postgres backups** (the always-on safety net, section 1).
2. **Manual `pg_dump` logical backups** (a portable copy you control, section 2).

> What this is NOT: `GET /api/export` is a PER-TENANT logical export of one tenant's own data. It is a
> user-facing data-portability feature, not a system backup, and it does NOT cover the full database
> (other tenants, account/subscription state, instance settings). See section 5.

---

## 1. Enable Railway automated Postgres backups (do this first)

Railway can snapshot the Postgres volume on a schedule. This is the baseline; turn it on before you
invite real users.

1. Open the Railway dashboard, the **s33k** project (s33k runs in its own project with a dedicated
   Postgres; Umami is the separate "s33k-analytics" project, see `CLAUDE.md` section A).
2. Click the **Postgres** service, then the **Backups** tab.
3. Enable **scheduled backups**.
4. Recommended cadence and retention for a paid, multi-tenant instance:
   - **Daily** backups.
   - **Retain at least 7 days** (14 to 30 days is better once there is real customer data; a problem is
     often noticed days after it happened).
5. Confirm at least one successful snapshot appears in the list before you rely on it. A backup setting
   with zero completed snapshots is not a backup.

To restore from a Railway snapshot, use the **Restore** action next to the snapshot in that same
Backups tab. Treat a restore as destructive (it replaces current data), so prefer restoring into a
scratch database first (section 3) and verifying before touching production.

---

## 2. Manual logical backup with `pg_dump` (a copy you control)

A logical dump is a portable SQL file you can store off Railway (a private bucket, an encrypted disk).
It is the copy that survives "the whole Railway project was deleted".

Get the connection string from Railway: **s33k project, Postgres service, Variables/Connect**, copy the
`DATABASE_URL` (or run `railway variables` against the linked Postgres service). Export it locally; do
NOT paste the literal host into any script or commit:

```bash
export DATABASE_URL="postgres://...your s33k Postgres connection string..."
```

### Back up

```bash
# Plain SQL dump (human-readable, easy to inspect). Date-stamped so backups never overwrite.
pg_dump "$DATABASE_URL" > s33k-$(date +%Y%m%d).sql

# Or the custom/compressed format (smaller, supports selective + parallel restore with pg_restore).
pg_dump --format=custom "$DATABASE_URL" > s33k-$(date +%Y%m%d).dump
```

Keep the resulting file somewhere off Railway and access-controlled. The dump contains every tenant's
data, so treat it like the production database itself.

### Restore

Restore into a database, ideally a fresh/scratch one first (section 3), then promote only after
verifying. `$RESTORE_URL` is the target you are restoring INTO.

```bash
# From a plain .sql dump:
psql "$RESTORE_URL" < s33k-YYYYMMDD.sql

# From a custom-format .dump (use pg_restore). --clean drops existing objects first;
# --no-owner avoids role-ownership mismatches between environments.
pg_restore --clean --no-owner --dbname "$RESTORE_URL" s33k-YYYYMMDD.dump
```

On a fresh empty target you can drop `--clean` (there is nothing to drop). On boot, s33k runs its
migrations (`entrypoint.sh`), and they swallow only already-applied (idempotency) errors, so an
up-to-date restored schema is left alone.

---

## 3. Restore-drill checklist (rehearse before you need it)

A backup you have never restored is a hope, not a backup. Run this drill periodically and after any
schema migration.

1. **Provision a scratch Postgres** (a throwaway Railway Postgres service, or a local
   `createdb s33k_restore_test`). Set `RESTORE_URL` to it. Never drill against production.
2. **Restore** the latest dump into the scratch DB (section 2 restore commands).
3. **Verify the core tables exist and carry rows.** Connect with `psql "$RESTORE_URL"` and run:

   ```sql
   SELECT count(*) FROM account;
   SELECT count(*) FROM domain;
   SELECT count(*) FROM keyword;
   ```

   Compare each count against production (run the same three `SELECT`s against the live `DATABASE_URL`,
   read-only). The numbers should match the backup's point in time. A zero where production has rows
   means the restore did not land that table; stop and investigate before trusting the backup.
4. **Spot-check a row.** `SELECT domain FROM domain LIMIT 5;` and confirm a known domain (e.g. the
   operator's own) is present.
5. **Tear down the scratch DB** so it does not linger or get mistaken for production.

If any step fails, the backup is not usable; fix the backup process before you depend on it.

---

## 4. What is in the database (so you know what a backup protects)

- `account` (tenants, subscription state, encrypted email + blind-index hash), `api_key`.
- `domain`, `keyword` (with full rank history), `setting` (the one global instance-settings row).
- Autocapture analytics events and related rows.
- `audit_log` (privileged-operator actions), and the rate-limit table when that backend is enabled.

Analytics page-view data read through Umami lives in the SEPARATE "s33k-analytics" project's Postgres;
back THAT up on its own (same section 1 steps, in that project) if you need to preserve raw traffic
history. A backup of the s33k database alone does not include the Umami store.

---

## 5. Why `GET /api/export` is NOT a backup

`GET /api/export` returns a single tenant's OWN data (its domains, keywords with rank history,
autocapture events, and account/key metadata) as one JSON bundle. It is a data-portability and
trust feature ("you can take your data with you"), scoped by `scopeWhere(account)` so a caller only
ever gets their own rows.

It is NOT a system backup because:

- It covers ONE tenant, not the whole instance (no other tenants, no instance settings, no audit log).
- It is JSON shaped for portability, not a restorable database image.
- There is no import counterpart that rebuilds the database from it.

Use it for "give me my data". Use sections 1 and 2 for "protect the instance".
