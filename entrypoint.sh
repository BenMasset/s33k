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

# Audit area 3 (CRITICAL): also reject THIS repo's own .env.example placeholders, not just the
# upstream SerpBear demo values. An operator who copies .env.example and only changes the obvious
# "change me" password would otherwise boot with a publicly-known SECRET (forge sessions, decrypt
# every stored credential) and APIKEY (full admin). Belt-and-suspenders: a positive length floor
# rejects any future short/weak example value too (real values are hex-34 / hex-24).
EXAMPLE_SECRET="replace-with-openssl-rand-hex-34"
EXAMPLE_APIKEY="replace-with-openssl-rand-hex-24"
EXAMPLE_PASSWORD="change-me-to-a-strong-password"
MIN_SECRET_LEN=40
MIN_APIKEY_LEN=32

if [ "$NODE_ENV" = "production" ]; then
  fail=0
  if [ -z "$APIKEY" ] || [ "$APIKEY" = "$DEMO_APIKEY" ] || [ "$APIKEY" = "$EXAMPLE_APIKEY" ] \
     || [ "${APIKEY#REGENERATE_ME}" != "$APIKEY" ] || [ "${#APIKEY}" -lt "$MIN_APIKEY_LEN" ]; then
    echo "[SECURITY] Refusing to start: APIKEY is unset, a demo/placeholder value, or too short. Generate one: openssl rand -hex 24" >&2
    fail=1
  fi
  if [ -z "$SECRET" ] || [ "$SECRET" = "$DEMO_SECRET" ] || [ "$SECRET" = "$EXAMPLE_SECRET" ] \
     || [ "${SECRET#REGENERATE_ME}" != "$SECRET" ] || [ "${#SECRET}" -lt "$MIN_SECRET_LEN" ]; then
    echo "[SECURITY] Refusing to start: SECRET is unset, a demo/placeholder value, or too short. Generate one: openssl rand -hex 34" >&2
    fail=1
  fi
  if [ -z "$PASSWORD" ] || [ "$PASSWORD" = "$DEMO_PASSWORD" ] || [ "$PASSWORD" = "change-me-please" ] \
     || [ "$PASSWORD" = "$EXAMPLE_PASSWORD" ]; then
    echo "[SECURITY] Refusing to start: PASSWORD is unset or set to a demo/placeholder value. Set a strong admin password." >&2
    fail=1
  fi
  if [ "$fail" = "1" ]; then
    echo "[SECURITY] Set strong APIKEY, SECRET, and PASSWORD env vars (see DEPLOY.md) and redeploy." >&2
    exit 1
  fi
fi

# The data volume is mounted at /app/data at runtime (Railway mounts it root-owned).
# The container runs as root, so it can create and open the SQLite database there
# directly, with no ownership dance.
mkdir -p /app/data

# Boot diagnostics: prove where we are and whether the DB path is writable.
echo "[DIAG] pwd=$(pwd) uid=$(id -u) DATABASE_PATH=${DATABASE_PATH:-unset}"
echo "[DIAG] ls -ld /app/data:"; ls -ld /app/data 2>&1
if touch /app/data/_writetest 2>/dev/null; then
  echo "[DIAG] /app/data is WRITABLE"; rm -f /app/data/_writetest
else
  echo "[DIAG] /app/data is NOT writable"
fi

npx sequelize-cli db:migrate --env production
exec "$@"
