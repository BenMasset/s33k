> **CURRENT STATE (read this first). Parts of this doc below are HISTORICAL and superseded.** The authoritative current reference is **CLAUDE.md section A**. The current truth:
>
> - **Production runs on Postgres via `DATABASE_URL`. NOT SQLite on a mounted Railway volume.** The SQLite-on-volume path threw `SQLITE_CANTOPEN` and is abandoned. SQLite is the local-only fallback when `DATABASE_URL` is unset.
> - **`railway up` is the deterministic deploy.** It uploads the working tree. Git-push / `railway add --repo` style deploys can ship a STALE pinned commit, which burned hours. New code is not live until you run `railway up`.
> - **s33k runs in its OWN Railway project ("s33k") with a dedicated Postgres. Umami is a SEPARATE project ("s33k-analytics").**
> - The SQLite + volume + su-exec sections below are kept for HISTORICAL context. Do not follow them for the database or project layout. See CLAUDE.md section A.

# Deploying s33k to Railway

This is the copy-pasteable recipe for hosting s33k (the open, MCP-controllable SEO + AEO + analytics control plane) on Railway. It takes about 10 minutes.

> HISTORICAL (superseded by the banner above): the paragraph that follows describes the SQLite-on-volume model. Production now uses Postgres via `DATABASE_URL`; see CLAUDE.md section A.

s33k is a single container built from this repo's `Dockerfile`. It keeps its own SQLite database in `/app/data`, so the one thing you must not skip is mounting a persistent volume there. Without the volume, every redeploy or restart wipes your domains, keywords, and settings.

Analytics is read from an existing self-hosted Umami; s33k does not run Umami for you on Railway. The Umami instance is already up at `https://umami-production-a400b.up.railway.app`.

---

## 1. What you are deploying

```
Railway service "s33k"
  built from:   this repo's Dockerfile (Node 22 alpine, Next.js standalone)
  listens on:   container port 3000
  volume:       /app/data   (SQLite DB lives here; MUST persist)
  analytics:    reads the existing self-hosted Umami over HTTPS
```

The SERP scraper key, the auth secrets, and the analytics connection are all supplied via environment variables. With env-configured scraping (added for hosted deploys), you do NOT have to open the Settings UI to paste the Serper key. The UI still works and a key entered there always overrides the env value.

---

## 2. Generate strong secrets first

Run these locally and keep the output. You will paste these into Railway's Variables tab.

```bash
# APIKEY: the Bearer token the REST API and the MCP server authenticate with.
openssl rand -hex 24

# SECRET: encrypts stored keys (Serper, SMTP, GSC) and signs login sessions.
openssl rand -hex 34

# PASSWORD: the admin login password. Use a real password manager value, or:
openssl rand -base64 24
```

Pick a `USER_NAME` (the admin login username, e.g. `admin` is fine; the username is not the secret, the password is).

The app refuses to boot in production (`NODE_ENV=production`, which the Dockerfile sets) if `APIKEY`, `SECRET`, or `PASSWORD` are unset, left as a `REGENERATE_ME...` placeholder, or set to the public SerpBear demo values. So you cannot accidentally ship the demo credentials.

---

## 3. Create the Railway service

1. Railway dashboard, "New Project", "Deploy from GitHub repo", pick this repo.
2. Railway detects the `Dockerfile` and builds from it. No build command or start command needed; the image's `ENTRYPOINT`/`CMD` run migrations and then start the server + cron.
3. In the service Settings, under "Networking", generate a public domain (e.g. `s33k-production-xxxx.up.railway.app`). Note it; you need it for `NEXT_PUBLIC_APP_URL`.

### Mount the persistent volume (do NOT skip this)

> HISTORICAL (superseded): this volume step belongs to the abandoned SQLite-on-volume path. Under the current Postgres model, provision a Postgres database in the s33k project and set `DATABASE_URL` instead. See CLAUDE.md section A.

1. In the service, open the "Variables" / "Volumes" area, "New Volume".
2. Set the mount path to exactly:

```
/app/data
```

That is where s33k writes `database.sqlite`, `settings.json`, and `failed_queue.json`. Mounting it here is what makes your data survive restarts and redeploys.

---

## 4. Environment variables

Paste these into Railway, "Variables", "Raw editor". Replace every `REPLACE_*` value. Lines you can leave as-is are marked.

```bash
# --- Auth (REQUIRED; generated in step 2) ------------------------------------
USER_NAME=admin
PASSWORD=REPLACE_WITH_STRONG_PASSWORD
SECRET=REPLACE_WITH_openssl_rand_hex_34
APIKEY=REPLACE_WITH_openssl_rand_hex_24
SESSION_DURATION=24

# --- Public URL (REQUIRED) ---------------------------------------------------
# The Railway public domain for THIS service, with https:// and no trailing slash.
NEXT_PUBLIC_APP_URL=https://REPLACE-with-your-railway-domain.up.railway.app

# --- SERP scraper (env-configured; no UI step needed) ------------------------
# Get a key at https://serper.dev (pay-as-you-go, ~$1 / 1000 lookups).
SCRAPER_TYPE=serper
SERPER_API_KEY=REPLACE_WITH_YOUR_SERPER_KEY

# --- Analytics: read from the existing self-hosted Umami ----------------------
ANALYTICS_PROVIDER=umami
UMAMI_BASE_URL=https://umami-production-a400b.up.railway.app
UMAMI_USERNAME=REPLACE_WITH_UMAMI_ADMIN_USERNAME
UMAMI_PASSWORD=REPLACE_WITH_UMAMI_ADMIN_PASSWORD
UMAMI_WEBSITE_ID=REPLACE_WITH_UMAMI_WEBSITE_ID
UMAMI_METRICS_TYPE=path

# --- Optional: Google Search Console (richer keyword data; safe to leave blank)
SEARCH_CONSOLE_CLIENT_EMAIL=
SEARCH_CONSOLE_PRIVATE_KEY=
```

Notes:

- `NODE_ENV=production` is baked into the image; you do not set it.
- `SCRAPER_TYPE` and `SERPER_API_KEY` are read from env when no scraper is configured in the Settings UI. A UI-entered key always wins, so existing UI-configured instances are unaffected. (`SCAPING_API` is also accepted as an alias for `SERPER_API_KEY`.)
- `UMAMI_WEBSITE_ID` comes from Umami, "Settings", "Websites", your site, "id". If you leave it blank, s33k tries to match the website by domain name instead.
- Instead of `UMAMI_USERNAME` + `UMAMI_PASSWORD` you may set a single pre-issued `UMAMI_API_KEY`.
- To use the legacy Lodd provider instead of Umami, set `ANALYTICS_PROVIDER=lodd` and provide `LODD_API_KEY` + `LODD_SITE`. Umami is the recommended owned path.

Deploy. The first boot runs `sequelize-cli db:migrate` against the empty SQLite DB on the volume, then starts the server and the scrape/notify cron.

---

## 5. Security checklist (before you point a domain at it)

- [ ] `APIKEY`, `SECRET`, and `PASSWORD` are freshly generated, not the demo values and not `REGENERATE_ME...` placeholders. (The app enforces this on boot, but verify your values are actually random.)
- [ ] The persistent volume is mounted at `/app/data` and shows a non-zero size after first boot.
- [ ] `NEXT_PUBLIC_APP_URL` is `https://` and matches the Railway public domain.
- [ ] The Umami credentials are read-only enough for your comfort, or you issued a dedicated `UMAMI_API_KEY` for s33k.
- [ ] Restrict the login: s33k has a single admin login and a global API key, so anyone with the URL sees the login page. If this instance is not meant to be public, put it behind Railway's private networking, an IP allowlist, or an auth proxy. At minimum, do not share the URL.
- [ ] Rotate the API key periodically: generate a new `openssl rand -hex 24`, update the `APIKEY` variable in Railway (triggers a redeploy), and update `S33K_API_KEY` in any MCP client config that points at this instance.

### MCP clients

The MCP server authenticates with the same `APIKEY`. In your MCP client config:

```
S33K_API_KEY = <the APIKEY value above>
S33K_BASE_URL = https://your-railway-domain.up.railway.app
```

---

## 6. Seed the getmasset.com keywords after first boot

Once the service is up and you can log in, seed data over the REST API with your `APIKEY`. Set two shell variables first:

```bash
export S33K_URL="https://your-railway-domain.up.railway.app"
export S33K_KEY="your-APIKEY-value"
```

### 6a. Add the domain

```bash
curl -s -X POST "$S33K_URL/api/domains" \
  -H "Authorization: Bearer $S33K_KEY" \
  -H "Content-Type: application/json" \
  -d '{"domains":["getmasset.com"]}'
```

### 6b. Add the keywords

`device` is `desktop` or `mobile`, `country` is a 2-letter code (e.g. `US`). `target_page` (optional) is the URL you want to rank for that keyword. Adjust the list to taste.

```bash
curl -s -X POST "$S33K_URL/api/keywords" \
  -H "Authorization: Bearer $S33K_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": [
      {"keyword":"AI ready content","domain":"getmasset.com","device":"desktop","country":"US","tags":"core","target_page":"https://www.getmasset.com/"},
      {"keyword":"marketing AI operations","domain":"getmasset.com","device":"desktop","country":"US","tags":"core","target_page":"https://www.getmasset.com/our-story"},
      {"keyword":"MCP server for marketing","domain":"getmasset.com","device":"desktop","country":"US","tags":"mcp","target_page":"https://www.getmasset.com/software/mcp"},
      {"keyword":"sales enablement content management","domain":"getmasset.com","device":"desktop","country":"US","tags":"category"},
      {"keyword":"digital asset management for marketing","domain":"getmasset.com","device":"desktop","country":"US","tags":"category"}
    ]
  }'
```

Each call returns the created records as JSON. A 401 means the `APIKEY` is wrong; a 400 with "Domain is Required" means you forgot the `domain` field on a keyword.

### 6c. Trigger the first SERP scrape

Adding keywords does not scrape immediately; the cron scrapes on its schedule. To pull positions right now, fetch the keyword IDs and refresh them:

```bash
# List keywords for the domain (note the "ID" field on each)
curl -s "$S33K_URL/api/keywords?domain=getmasset.com" \
  -H "Authorization: Bearer $S33K_KEY"

# Refresh by comma-separated IDs (replace 1,2,3 with the real IDs)
curl -s -X POST "$S33K_URL/api/refresh?id=1,2,3" \
  -H "Authorization: Bearer $S33K_KEY"
```

If a refresh returns no positions, the most common cause is a missing or wrong `SERPER_API_KEY`, or a Serper account out of credits.

---

## 7. Day-2 operations

- **Backups:** the whole state is the volume at `/app/data`. Snapshot it (Railway volume backup, or periodically `GET /api/domains` + `GET /api/keywords?domain=...` and store the JSON).
- **Upgrades:** push to the connected branch; Railway rebuilds the image. The volume persists across the redeploy, so data is kept.
- **Logs:** Railway service "Logs". `[SECURITY]` lines mean a credential is still a demo/placeholder value and the boot was refused.
