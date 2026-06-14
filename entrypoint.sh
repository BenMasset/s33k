#!/bin/sh

# -----------------------------------------------------------------------------
# Production safety: refuse to boot with the public SerpBear demo credentials.
# These are the values shipped in the upstream demo and in this repo's example
# files. Running a public instance with them means anyone can log in and call
# the API. This check only fires when NODE_ENV=production, so local dev (which
# uses the demo defaults intentionally) is unchanged.
# -----------------------------------------------------------------------------
DEMO_APIKEY="5saedXklbslhnapihe2pihp3pih4fdnakhjwq5"
DEMO_SECRET="4715aed3216f7b0a38e6b534a958362654e96d10fbc04700770d572af3dce43625dd"
DEMO_PASSWORD="0123456789"

if [ "$NODE_ENV" = "production" ]; then
  fail=0
  if [ -z "$APIKEY" ] || [ "$APIKEY" = "$DEMO_APIKEY" ] || [ "${APIKEY#REGENERATE_ME}" != "$APIKEY" ]; then
    echo "[SECURITY] Refusing to start: APIKEY is unset or set to a demo/placeholder value. Generate one: openssl rand -hex 24" >&2
    fail=1
  fi
  if [ -z "$SECRET" ] || [ "$SECRET" = "$DEMO_SECRET" ] || [ "${SECRET#REGENERATE_ME}" != "$SECRET" ]; then
    echo "[SECURITY] Refusing to start: SECRET is unset or set to a demo/placeholder value. Generate one: openssl rand -hex 34" >&2
    fail=1
  fi
  if [ -z "$PASSWORD" ] || [ "$PASSWORD" = "$DEMO_PASSWORD" ] || [ "$PASSWORD" = "change-me-please" ]; then
    echo "[SECURITY] Refusing to start: PASSWORD is unset or set to a demo/placeholder value. Set a strong admin password." >&2
    fail=1
  fi
  if [ "$fail" = "1" ]; then
    echo "[SECURITY] Set strong APIKEY, SECRET, and PASSWORD env vars (see DEPLOY.md) and redeploy." >&2
    exit 1
  fi
fi

npx sequelize-cli db:migrate --env production
exec "$@"
