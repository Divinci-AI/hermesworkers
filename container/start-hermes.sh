#!/bin/bash
# Hermes container startup script.
#
# Launches:
#   1. The Hermes API server (OpenAI-compatible /v1/chat/completions) on port 18789.
#   2. The Hermes native dashboard (web UI + WebSocket) on port 9119, in background.
#
# Provider API keys (Anthropic, OpenRouter, OpenAI) are injected through environment
# variables by the Worker at process start. Hermes reads them from ~/.hermes/.env,
# so we materialize that file from the environment on every boot.
#
# The script runs as root (the Sandbox control plane launches it), writes config
# and secrets, then DROPS PRIVILEGES via gosu so the long-running Hermes gateway
# and dashboard — which execute tools on behalf of prompts — run as the
# unprivileged `hermes` user.

set -euo pipefail

RUN_USER=hermes
LOG_FILE=/tmp/hermes-server.log
DASHBOARD_LOG=/tmp/hermes-dashboard.log

echo "=== hermesworkers container startup ===" >&2
echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes}" >&2
echo "OPENROUTER_API_KEY set: ${OPENROUTER_API_KEY:+yes}" >&2
echo "OPENAI_API_KEY set: ${OPENAI_API_KEY:+yes}" >&2
echo "HERMES_GATEWAY_TOKEN set: ${HERMES_GATEWAY_TOKEN:+yes}" >&2
echo "HOME: ${HOME:-/home/hermes}" >&2

# The Worker↔container shared secret is mandatory. Refuse to start an
# unauthenticated gateway rather than falling back to a well-known default.
if [ -z "${HERMES_GATEWAY_TOKEN:-}" ]; then
    echo "FATAL: HERMES_GATEWAY_TOKEN is not set. The gateway will not start unauthenticated." >&2
    echo "       Set it with: wrangler secret put HERMES_GATEWAY_TOKEN" >&2
    exit 1
fi

# Guard: do not start a duplicate gateway if the script is re-invoked while one is alive.
if pgrep -f "hermes gateway" > /dev/null 2>&1; then
    echo "Hermes gateway already running, exiting." >&2
    exit 0
fi

HOME_DIR="${HOME:-/home/hermes}"
mkdir -p "$HOME_DIR/.hermes"
chmod 700 "$HOME_DIR/.hermes"

# Configure the Hermes API server before launching the gateway.
# We bind to 18789 (not Hermes' default 8642) so the Worker has a stable target port.
hermes config set API_SERVER_ENABLED true
hermes config set API_SERVER_KEY "${HERMES_GATEWAY_TOKEN}"
hermes config set API_SERVER_PORT 18789

# Hermes reads provider keys + feature flags from ~/.hermes/.env, NOT system env vars.
# Rebuild the file from scratch on each boot so the latest secrets are picked up.
HERMES_ENV_FILE="$HOME_DIR/.hermes/.env"
umask 077
: > "$HERMES_ENV_FILE"
echo "GATEWAY_ALLOW_ALL_USERS=true" >> "$HERMES_ENV_FILE"
[ -n "${ANTHROPIC_API_KEY:-}" ]  && echo "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"   >> "$HERMES_ENV_FILE" || true
[ -n "${OPENROUTER_API_KEY:-}" ] && echo "OPENROUTER_API_KEY=${OPENROUTER_API_KEY}" >> "$HERMES_ENV_FILE" || true
[ -n "${OPENAI_API_KEY:-}" ]     && echo "OPENAI_API_KEY=${OPENAI_API_KEY}"         >> "$HERMES_ENV_FILE" || true
[ -n "${GEMINI_API_KEY:-}" ]     && echo "GEMINI_API_KEY=${GEMINI_API_KEY}"         >> "$HERMES_ENV_FILE" || true
[ -n "${GOOGLE_API_KEY:-}" ]     && echo "GOOGLE_API_KEY=${GOOGLE_API_KEY}"         >> "$HERMES_ENV_FILE" || true
[ -n "${NOUS_API_KEY:-}" ]       && echo "NOUS_API_KEY=${NOUS_API_KEY}"             >> "$HERMES_ENV_FILE" || true

# Platform: Cloudflare Workers AI (Divinci-paid). litellm reads both to route
# `cloudflare/@cf/…` model ids. Passed as a pair by collectProviderKeys().
[ -n "${CLOUDFLARE_API_KEY:-}" ]    && echo "CLOUDFLARE_API_KEY=${CLOUDFLARE_API_KEY}"       >> "$HERMES_ENV_FILE" || true
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] && echo "CLOUDFLARE_ACCOUNT_ID=${CLOUDFLARE_ACCOUNT_ID}" >> "$HERMES_ENV_FILE" || true

# Platform: Vertex AI / Gemini (Divinci-paid). litellm reads VERTEXAI_PROJECT +
# VERTEXAI_LOCATION and the service-account credentials to route `vertex_ai/…`
# and refreshes the OAuth token itself. The SA JSON arrives inline as
# VERTEX_SA_JSON (a Worker secret); materialize it to a 0600 file and point
# GOOGLE_APPLICATION_CREDENTIALS at it — a file path is unambiguous where an
# inline multi-line JSON blob in a .env line would be fragile to quote.
[ -n "${VERTEXAI_PROJECT:-}" ]  && echo "VERTEXAI_PROJECT=${VERTEXAI_PROJECT}"   >> "$HERMES_ENV_FILE" || true
[ -n "${VERTEXAI_LOCATION:-}" ] && echo "VERTEXAI_LOCATION=${VERTEXAI_LOCATION}" >> "$HERMES_ENV_FILE" || true
if [ -n "${VERTEX_SA_JSON:-}" ]; then
    VERTEX_SA_FILE="$HOME_DIR/.hermes/vertex-sa.json"
    printf '%s' "${VERTEX_SA_JSON}" > "$VERTEX_SA_FILE"
    chmod 600 "$VERTEX_SA_FILE"
    echo "GOOGLE_APPLICATION_CREDENTIALS=${VERTEX_SA_FILE}" >> "$HERMES_ENV_FILE"
fi

chmod 600 "$HERMES_ENV_FILE"
echo "[startup] wrote $HERMES_ENV_FILE ($(wc -l < "$HERMES_ENV_FILE") lines)" >> "$LOG_FILE"

# Bind to all interfaces. Cloudflare Sandbox `containerFetch` reaches the container via 10.0.0.1
# (external IP), not loopback. Hermes defaults to 127.0.0.1 which is unreachable from the Worker.
hermes config set API_SERVER_HOST 0.0.0.0 || hermes config set API_SERVER_BIND 0.0.0.0 || true

# Pin a default model so the API server can route requests when the caller does not specify one,
# or when the supplied model is not pre-registered with Hermes. Override with HERMES_DEFAULT_MODEL.
hermes config set model "${HERMES_DEFAULT_MODEL:-anthropic/claude-sonnet-4-5}" || true

# Everything under ~/.hermes was written as root; hand it to the runtime user
# (mode preserved: .hermes 0700, .env 0600) so the de-rooted gateway can read it.
chown -R "${RUN_USER}:${RUN_USER}" "$HOME_DIR/.hermes"

# Logs must be writable by the de-rooted processes that append to them.
touch "$LOG_FILE" "$DASHBOARD_LOG"
chown "${RUN_USER}:${RUN_USER}" "$LOG_FILE" "$DASHBOARD_LOG"

# Launch the native Hermes dashboard (web UI on port 9119) in the background, as
# the unprivileged user. `--insecure` lets Hermes bind 0.0.0.0; this is safe in
# our topology because the container is unreachable from the public internet
# except through the Worker proxy. See docs/architecture.md.
echo "=== $(date -u) launching hermes dashboard on 0.0.0.0:9119 (user=${RUN_USER}) ===" >> "$DASHBOARD_LOG"
gosu "${RUN_USER}" hermes dashboard --host 0.0.0.0 --port 9119 --insecure >> "$DASHBOARD_LOG" 2>&1 &
DASHBOARD_PID=$!
echo "Dashboard launched (pid=$DASHBOARD_PID)" >&2

# Launch the gateway in the foreground as the unprivileged user. Its
# stdout/stderr are tee'd to a log file the Worker can read.
echo "=== $(date -u) launching hermes gateway (user=${RUN_USER}) ===" >> "$LOG_FILE"
exec gosu "${RUN_USER}" hermes gateway >> "$LOG_FILE" 2>&1
