#!/usr/bin/env bash
# One-shot: deploy the STUB image to staging, run the isolation smoke test, tear
# down. Proves per-agent container isolation without a real Hermes image.
#
# Requires: Docker running; a Cloudflare account with Containers enabled; a token
# with Workers Scripts:Edit + Containers scope. By default reads the token +
# account from the Divinci staging creds file; override with CF_TOKEN / CF_ACCT.
#
# Usage:
#   ./scripts/deploy-staging-stub.sh deploy     # config + deploy + set secrets
#   ./scripts/deploy-staging-stub.sh smoke       # run isolation-smoke.sh
#   ./scripts/deploy-staging-stub.sh teardown    # delete the worker + container
#   ./scripts/deploy-staging-stub.sh all         # deploy → smoke → teardown
#
# Secrets are generated locally and written to .staging-test-secrets.env
# (gitignored) — never printed to stdout.

set -euo pipefail
cd "$(dirname "$0")/.."

WORKER_NAME="${WORKER_NAME:-hermesworkers-staging}"
CREDS="${CREDS:-/Users/mikeumus/Documents/server/private-keys/staging/cloudflare.env}"
WRANGLER="${WRANGLER:-npx --yes wrangler@4}"   # Containers need a recent wrangler
SECRETS_FILE=".staging-test-secrets.env"

load_creds() {
  CF_TOKEN="${CF_TOKEN:-$(sed -nE 's/\r$//; s/^CLOUDFLARE_API_TOKEN=["'\'']?([^"'\'']*)["'\'']?$/\1/p' "$CREDS" | head -1)}"
  CF_ACCT="${CF_ACCT:-$(sed -nE 's/\r$//; s/^CLOUDFLARE_ACCOUNT_ID=["'\'']?([^"'\'']*)["'\'']?$/\1/p' "$CREDS" | head -1)}"
  [ -n "$CF_TOKEN" ] && [ -n "$CF_ACCT" ] || { echo "Missing CF_TOKEN/CF_ACCT"; exit 1; }
  export CLOUDFLARE_API_TOKEN="$CF_TOKEN"
}

write_config() {
  cat > wrangler.staging.toml <<TOML
name = "${WORKER_NAME}"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]
account_id = "${CF_ACCT}"

[[durable_objects.bindings]]
name = "HERMES"
class_name = "HermesInstance"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["HermesInstance"]

[[containers]]
class_name = "HermesInstance"
image = "./container/Dockerfile.stub"
max_instances = 10
instance_type = "standard-1"
TOML
  echo "wrote wrangler.staging.toml (worker=${WORKER_NAME})"
}

do_deploy() {
  load_creds; write_config
  npm ci
  npm run typecheck && npm test
  $WRANGLER deploy -c wrangler.staging.toml
  if [ ! -f "$SECRETS_FILE" ]; then
    { echo "HERMES_GATEWAY_TOKEN=$(openssl rand -hex 32)";
      echo "SERVICE_AUTH_SECRET=$(openssl rand -hex 32)"; } > "$SECRETS_FILE"
  fi
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  printf '%s' "$HERMES_GATEWAY_TOKEN" | $WRANGLER secret put HERMES_GATEWAY_TOKEN -c wrangler.staging.toml
  printf '%s' "$SERVICE_AUTH_SECRET"  | $WRANGLER secret put SERVICE_AUTH_SECRET  -c wrangler.staging.toml
  echo "Deployed. Secrets in $SECRETS_FILE."
}

do_smoke() {
  load_creds
  # shellcheck disable=SC1090
  . "$SECRETS_FILE"
  local sub url
  sub="$($WRANGLER whoami 2>/dev/null | grep -oiE '[a-z0-9-]+\.workers\.dev' | head -1)"
  url="${WORKER_URL:-https://${WORKER_NAME}.${sub}}"
  echo "Smoke against $url"
  WORKER_URL="$url" SERVICE_AUTH_SECRET="$SERVICE_AUTH_SECRET" ./scripts/isolation-smoke.sh
}

do_teardown() {
  load_creds
  $WRANGLER delete -c wrangler.staging.toml --force || \
    echo "Manual teardown: $WRANGLER delete --name ${WORKER_NAME} --force"
  rm -f wrangler.staging.toml
  echo "Torn down. Keep $SECRETS_FILE only if re-deploying."
}

case "${1:-all}" in
  deploy)   do_deploy ;;
  smoke)    do_smoke ;;
  teardown) do_teardown ;;
  all)      do_deploy; do_smoke; do_teardown ;;
  *) echo "usage: $0 {deploy|smoke|teardown|all}"; exit 1 ;;
esac
