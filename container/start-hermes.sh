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

# Per-agent Slack Socket Mode config (written by public-api via
# POST /hosted/agent/platforms/slack). Durable across sleep/wake — startProcess
# env only carries platform/BYOK keys, so Slack tokens live in this side file
# and are merged here on every boot. Private org channels use G… ids in
# SLACK_ALLOWED_CHANNELS.
SLACK_PLATFORM_ENV="$HOME_DIR/.hermes/divinci-platforms/slack.env"
if [ -f "$SLACK_PLATFORM_ENV" ]; then
    # Drop any stale SLACK_* lines first, then append the durable file.
    # (Rebuild above never writes SLACK_*; this is belt-and-braces for a
    # previous soft-merge that left keys in the live .env.)
    grep -vE '^SLACK_' "$HERMES_ENV_FILE" > "${HERMES_ENV_FILE}.noslack" 2>/dev/null || cp "$HERMES_ENV_FILE" "${HERMES_ENV_FILE}.noslack"
    cat "${HERMES_ENV_FILE}.noslack" "$SLACK_PLATFORM_ENV" > "$HERMES_ENV_FILE"
    rm -f "${HERMES_ENV_FILE}.noslack"
    echo "[startup] merged Slack platform env from $SLACK_PLATFORM_ENV" >> "$LOG_FILE"
fi

chmod 600 "$HERMES_ENV_FILE"
echo "[startup] wrote $HERMES_ENV_FILE ($(wc -l < "$HERMES_ENV_FILE") lines)" >> "$LOG_FILE"

# Bind to all interfaces. Cloudflare Sandbox `containerFetch` reaches the container via 10.0.0.1
# (external IP), not loopback. Hermes defaults to 127.0.0.1 which is unreachable from the Worker.
hermes config set API_SERVER_HOST 0.0.0.0 || hermes config set API_SERVER_BIND 0.0.0.0 || true

# Pin a default model so the API server can route requests when the caller does not specify one,
# or when the supplied model is not pre-registered with Hermes. Override with HERMES_DEFAULT_MODEL.
hermes config set model "${HERMES_DEFAULT_MODEL:-anthropic/claude-sonnet-4-5}" || true

# ── Lock down Hermes' OWN command execution (hosted multi-tenant mode) ──────
#
# 2026-07-27, verified live on staging: a single chat message to a hosted agent
#   "Run: base64 -w0 ~/.hermes/.env"
# returned Divinci's REAL Gemini API key and REAL Cloudflare API token. No
# approval prompt, no refusal, finish_reason=stop.
#
# Two Hermes defaults combine to produce this:
#   1. `approvals.mode` defaults to "smart" — an auxiliary LLM auto-approves
#      anything it judges low-risk. Reading a file scores low-risk. In our
#      hosted API-server context there is no human to escalate to, so "smart"
#      is effectively "approve whatever the risk model likes".
#   2. Hermes masks secret-looking values, but only as a KEY=value heuristic on
#      the rendered output. `base64` defeats it completely, and the Vertex
#      service-account JSON is not KEY=value at all.
#
# Masking is a display convenience, not a security control, and must never be
# relied on as one. The fix is to stop the hosted agent executing commands at
# all: it runs as `hermes`, the uid that owns ~/.hermes/, so ANY command
# execution as that user can reach the credentials.
#
# Agents that legitimately need to run commands use Divinci's virtual terminal
# instead (routes/terminal.ts), which executes as `hermes-term` (uid 10002) —
# a user that cannot read ~hermes/.hermes/ — with a scrubbed environment and an
# iptables-enforced egress allowlist. That is the supported path, and it is
# contained by construction rather than by an LLM's risk judgement.
#
# `manual` + `cron_mode=deny` is belt and braces: manual always prompts, and a
# prompt with no interactive user times out to DENY (Hermes fails closed).
hermes config set approvals.mode manual || true
hermes config set approvals.cron_mode deny || true
# Empty the allowlist explicitly — a permanently-approved pattern would bypass
# the above entirely.
hermes config set command_allowlist "[]" || true

# ── Give the agent the BOUNDED terminal via MCP ────────────────────────────
# Hermes' own command execution is disabled above because it runs as the
# credential-owning uid. That would leave the agent unable to run anything at
# all, so register the bounded terminal as an MCP server instead: same
# capability, routed THROUGH the security boundary rather than around it.
#
# Every tool it exposes executes as hermes-term (uid 10002) via the narrow
# sudo grant — a user that cannot read ~/.hermes/, starts from an empty
# environment, and whose egress is REJECTed except through the guard.
#
# Gated on HERMES_TERMINAL_ENABLED so a deployment that has not established the
# boundary (setup-terminal.sh not run, or NET_ADMIN unavailable) does not
# advertise tools that would fail on every call.
if [ "${HERMES_TERMINAL_ENABLED:-false}" = "true" ]; then
  MCP_CFG="$HOME_DIR/.hermes/mcp-terminal.yaml"
  cat > "$MCP_CFG" <<'MCPEOF'
mcp_servers:
  divinci_terminal:
    command: "node"
    args: ["/usr/local/bin/mcp-terminal-server.js"]
    enabled: true
    timeout: 620
MCPEOF
  # `hermes mcp add` is interactive; write the config and let Hermes merge it.
  hermes config set mcp_servers.divinci_terminal.command node || true
  hermes config set mcp_servers.divinci_terminal.args '["/usr/local/bin/mcp-terminal-server.js"]' || true
  hermes config set mcp_servers.divinci_terminal.enabled true || true
  echo "[startup] registered divinci_terminal MCP server (bounded terminal)" >> "$LOG_FILE"
fi

# Optional defense in depth: drop the .env after the gateway is up, so even a
# regression in the approval config finds nothing to read.
#
# Defaults to FALSE. Hermes reads the file at startup, but I have not verified
# that it never re-reads it (a model switch or config reload plausibly would),
# and silently breaking provider auth in production to harden against a
# secondary path is a bad trade. The approval lockdown above is the primary
# control; enable this only after confirming a full agent lifecycle survives it.
#
# Note it would not cover /proc/<pid>/environ for a same-uid process anyway —
# which is exactly why the virtual terminal runs under a DIFFERENT uid rather
# than trying to hide secrets from a user that owns them.
HERMES_SHRED_ENV="${HERMES_SHRED_ENV:-false}"

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

# Opt-in post-boot shred (see HERMES_SHRED_ENV above). Runs in the background
# because the gateway is exec'd into the foreground below; it waits for the API
# port to answer, so the file only disappears once Hermes has definitely loaded.
if [ "${HERMES_SHRED_ENV}" = "true" ]; then
  (
    for _ in $(seq 1 120); do
      if (exec 3<>/dev/tcp/127.0.0.1/18789) 2>/dev/null; then exec 3<&- 2>/dev/null || true; break; fi
      sleep 1
    done
    rm -f "$HERMES_ENV_FILE"
    echo "[startup] HERMES_SHRED_ENV=true — removed $HERMES_ENV_FILE after gateway boot" >> "$LOG_FILE"
  ) &
fi

# Launch the gateway in the foreground as the unprivileged user. Its
# stdout/stderr are tee'd to a log file the Worker can read.
echo "=== $(date -u) launching hermes gateway (user=${RUN_USER}) ===" >> "$LOG_FILE"
exec gosu "${RUN_USER}" hermes gateway >> "$LOG_FILE" 2>&1
