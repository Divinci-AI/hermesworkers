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

# ── Cloudflare Workers AI via the OpenAI-compatible endpoint ────────────────
#
# litellm's built-in `cloudflare/` provider is BROKEN against Workers AI today.
# Verified on staging 2026-08-06: every `cloudflare/@cf/*` model (Kimi K2.7-Code
# AND Llama 3.3, so it is not model-specific) fails in under a second with
#   "Attempted to access streaming response content, without having called read()"
# while the exact same model answers fine on Cloudflare's own REST endpoint.
# The adapter still expects the old text-generation body shape
# (`{"result":{"response":"…"}}`) and mis-parses today's OpenAI-shaped one,
# then throws again on its own error path.
#
# Cloudflare also serves an OpenAI-compatible endpoint, so register it as a
# NAMED provider and sidestep the broken adapter entirely. Models are then
# addressed as `cfai/@cf/<vendor>/<model>`.
#
# Only wired when BOTH the token and the account id are present — same
# all-or-nothing rule as collectProviderKeys, so a half-configured Worker never
# advertises a provider it cannot reach.
if [ -n "${CLOUDFLARE_API_KEY:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    CF_AI_BASE="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1"
    # `providers.<slug>`, NOT `model.providers.<slug>`. Hermes reads user
    # providers with a top-level `cfg.get("providers")` (hermes_cli/doctor.py,
    # hermes_cli/providers.py::resolve_user_provider) and nothing in the CLI
    # reads `model.providers` at all. `hermes config set` accepts any dotted
    # path, so the wrong prefix was written, echoed back a ✓, and resolved to
    # nothing — which is why the cfai workaround failed with the same error as
    # the broken `cloudflare/` adapter it was meant to sidestep.
    hermes config set providers.cfai.base_url "$CF_AI_BASE" >> "$LOG_FILE" 2>&1 || true
    hermes config set providers.cfai.key_env "CLOUDFLARE_API_KEY" >> "$LOG_FILE" 2>&1 || true
    echo "[startup] registered cfai provider -> $CF_AI_BASE" >> "$LOG_FILE"
else
    echo "[startup] cfai provider NOT registered (need CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID)" >> "$LOG_FILE"
fi

# Pin a default model so the API server can route requests when the caller does not specify one,
# or when the supplied model is not pre-registered with Hermes. Override with HERMES_DEFAULT_MODEL.
#
# PRECEDENCE: a PER-AGENT pin (written by POST /hosted/agent/config) beats the
# Worker-wide HERMES_DEFAULT_MODEL secret. Without this, every agent on a Worker
# answered gateway traffic — Slack included — on the same model regardless of
# its own hermesModel, because only Divinci-routed chats got the agent's choice.
AGENT_MODEL_ENV="$HOME_DIR/.hermes/divinci-platforms/model.env"
AGENT_MODEL=""
if [ -f "$AGENT_MODEL_ENV" ]; then
    # shellcheck disable=SC1090
    AGENT_MODEL="$(sed -n 's/^HERMES_AGENT_MODEL=//p' "$AGENT_MODEL_ENV" | head -n1)"
fi
EFFECTIVE_MODEL="${AGENT_MODEL:-${HERMES_DEFAULT_MODEL:-anthropic/claude-sonnet-4-5}}"
hermes config set model "$EFFECTIVE_MODEL" || true
echo "[startup] model=$EFFECTIVE_MODEL (per-agent=${AGENT_MODEL:-none})" >> "$LOG_FILE"

# Per-agent identity. Hermes loads SOUL.md from HERMES_HOME as slot #1 of the
# system prompt, replacing its built-in identity — so this is what makes an
# agent's persona apply to Slack and not just to Divinci-routed chats.
# The file is written by POST /hosted/agent/config and survives sleep/wake;
# nothing to do here but make sure ownership is right after a cold start.
if [ -f "$HOME_DIR/.hermes/SOUL.md" ]; then
    chown hermes:hermes "$HOME_DIR/.hermes/SOUL.md" 2>/dev/null || true
    echo "[startup] SOUL.md present ($(wc -c < "$HOME_DIR/.hermes/SOUL.md") bytes)" >> "$LOG_FILE"
fi

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
# Approval modes (Hermes docs):
#   manual — always prompt (Slack buttons: Allow Once / Session / Always Allow)
#   smart  — LLM risk score auto-approves "low risk" (unsafe for hosted: no human)
#   off    — YOLO: no prompts (equivalent to /yolo). Use only in trusted dogfood.
#
# Default remains MANUAL for multi-tenant safety. Divinci dogfood (Fulcrum +
# Slack) sets HERMES_APPROVALS_MODE=off so Slack "Allow" buttons are not required
# — those buttons are flaky on HTTP Events (popup doesn't dismiss / session never
# resumes). Override at boot: HERMES_APPROVALS_MODE=manual|smart|off.
APPROVALS_MODE="${HERMES_APPROVALS_MODE:-manual}"
case "${APPROVALS_MODE}" in
  off|smart|manual) ;;
  *) APPROVALS_MODE=manual ;;
esac
hermes config set approvals.mode "${APPROVALS_MODE}" || true
hermes config set approvals.cron_mode deny || true
# Empty the allowlist when locking down. When mode=off the list is unused.
#
# ⚠️ THIRD instance of the config-set-list bug (see divinci_terminal below).
# `hermes config set command_allowlist "[]"` stored the two-character STRING
# "[]", and `load_permanent_allowlist()` does `set(config.get(...) or [])` —
# so `set("[]")` produced the allowlist `{"[", "]"}` rather than an empty one.
#
# Measured, before assuming the worst: the effect is benign. Those two
# patterns match only the literal commands `[` and `]`; `ls`, `rm -rf /` and
# `base64 ~/.hermes/.env` are all still unapproved, and the truthy value only
# means `load_permanent()` is called with a pair of useless entries. So this
# never opened a hole — but it is the same latent defect, and the day someone
# sets a REAL allowlist through this line it would be parsed character by
# character. Write the list properly instead.
if [ "${APPROVALS_MODE}" = "manual" ] || [ "${APPROVALS_MODE}" = "smart" ]; then
  /opt/hermes-venv/bin/python - "$HOME_DIR/.hermes/config.yaml" <<'ALEOF' >> "$LOG_FILE" 2>&1 || true
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
try:
    cfg = yaml.safe_load(p.read_text()) if p.exists() else {}
except Exception as e:
    print(f"[startup] command_allowlist: config unreadable ({e}) — NOT cleared")
    raise SystemExit(0)
if not isinstance(cfg, dict):
    cfg = {}
cfg["command_allowlist"] = []
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False))
check = yaml.safe_load(p.read_text()) or {}
got = check.get("command_allowlist")
print(
    f"[startup] command_allowlist={'OK' if isinstance(got, list) and not got else 'FAILED'} "
    f"type={type(got).__name__} value={got!r}"
)
ALEOF
fi
echo "[startup] approvals.mode=${APPROVALS_MODE}" >> "$LOG_FILE"

# ── Unattended-turn tool guard ─────────────────────────────────────────────
#
# ⚠️ approvals.mode above does NOT gate MCP tool calls. It is consumed by
# exactly two callers in hermes-agent v2026.7.7.2 —
# check_all_command_guards (tools/terminal_tool.py) and
# check_execute_code_guard (tools/code_execution_tool.py). MCP calls dispatch
# through model_tools.py, whose ONLY gate is a plugin `pre_tool_call` hook.
#
# So an inbound email could reach Fulcrum's execute_command / write_file — on
# the FULCRUM host, outside every boundary this image builds — with no human
# anywhere in the loop. Observed live 2026-08-14T05:32Z.
#
# This plugin is the fix, and the only mechanism Hermes offers for it. It
# allows the full toolset on interactive Slack turns
# (HERMES_SESSION_PLATFORM=slack) and restricts unattended API-server turns
# (the email path) to a read-and-file allowlist. See plugins/
# divinci_email_guard/policy.py for the source-level reasoning.
#
# Re-installed from the root-owned staging copy on EVERY boot, so a modified
# copy under ~/.hermes cannot persist across a restart.
GUARD_SRC="/usr/local/share/divinci-hermes-plugins/divinci_email_guard"
# Derive both paths from HOME_DIR, the same base every other path in this
# script uses. HERMES_HOME is NOT set in the image (only HOME is), so reading
# it here would work only by falling through to a hardcoded default — which
# silently diverges the moment a profile sets it.
GUARD_DEST="$HOME_DIR/.hermes/plugins/divinci_email_guard"
HERMES_CFG="$HOME_DIR/.hermes/config.yaml"
if [ -d "$GUARD_SRC" ]; then
  mkdir -p "$(dirname "$GUARD_DEST")"
  rm -rf "$GUARD_DEST"
  cp -R "$GUARD_SRC" "$GUARD_DEST"
  # ⚠️ A user plugin is INERT unless its key is in plugins.enabled, and the
  # only trace of a skipped plugin is a DEBUG line. Installing the files
  # without this yields a guard that appears present and enforces nothing.
  #
  # ⚠️ WRITTEN AS YAML DIRECTLY, NOT VIA `hermes config set`. The loader
  # requires a LIST — `_get_enabled_plugins()` does `isinstance(enabled, list)`
  # and returns None (meaning "nothing enabled") for anything else. A
  # `hermes config set plugins.enabled '["x"]'` stored the value as a STRING,
  # so the key was present, the command reported success, and every plugin
  # silently stayed off. That is what happened on 2026-08-14: the boot log said
  # "installed + enabled" while the guard was never loaded, and the mistake was
  # only caught because a terminal command that should have been refused ran.
  #
  # This writes the key with the YAML parser Hermes itself uses, then READS IT
  # BACK and logs the parsed type. A log line that reports what was attempted
  # rather than what is true is worse than no log line at all.
  /opt/hermes-venv/bin/python - "$HERMES_CFG" <<'PYEOF' >> "$LOG_FILE" 2>&1 || true
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
try:
    cfg = yaml.safe_load(p.read_text()) if p.exists() else {}
except Exception as e:
    print(f"[startup] divinci_email_guard: config unreadable ({e}) — NOT enabled")
    raise SystemExit(0)
if not isinstance(cfg, dict):
    cfg = {}
plugins = cfg.get("plugins")
if not isinstance(plugins, dict):
    plugins = {}
enabled = plugins.get("enabled")
if not isinstance(enabled, list):
    enabled = []
if "divinci_email_guard" not in enabled:
    enabled.append("divinci_email_guard")
plugins["enabled"] = enabled
cfg["plugins"] = plugins
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False))

# Read back from disk — never trust the write we just made.
check = yaml.safe_load(p.read_text()) or {}
got = (check.get("plugins") or {}).get("enabled")
ok = isinstance(got, list) and "divinci_email_guard" in got
print(
    f"[startup] divinci_email_guard enabled={'OK' if ok else 'FAILED'} "
    f"type={type(got).__name__} value={got!r}"
)
PYEOF
  echo "[startup] divinci_email_guard files installed" >> "$LOG_FILE"
else
  # Loud, because the alternative is an unattended path silently running
  # unguarded. Not fatal: Slack-only deployments are still useful, and a
  # container that refuses to boot is a worse failure than one that boots
  # with a recorded warning.
  echo "[startup] WARNING: divinci_email_guard NOT FOUND at ${GUARD_SRC} — unattended turns are UNGUARDED" >> "$LOG_FILE"
fi

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
  # ⚠️ WRITTEN AS YAML DIRECTLY, NOT VIA `hermes config set` — the SAME bug
  # that silently disabled the plugin above, and it had been breaking this
  # server since it was written.
  #
  # `set_config_value` coerces only booleans, ints and floats; there is no
  # JSON parsing. So
  #     hermes config set mcp_servers.divinci_terminal.args '["/usr/.../x.js"]'
  # stored the literal STRING `["/usr/local/bin/mcp-terminal-server.js"]`.
  # `mcp_tool.py` then reads `args = config.get("args", [])` and splats it —
  # `[command, *args]` — which iterates a string CHARACTER BY CHARACTER. node
  # was being launched with `[` as its script path and 41 more one-character
  # arguments, so it died instantly and the connection closed.
  #
  # That produced 1,472 log lines of
  #     MCP server 'divinci_terminal' failed initial connection ... TaskGroup
  # and, far worse, it silently removed the terminal BOUNDARY: the agent kept
  # working because Hermes' BUILT-IN terminal still ran — as `hermes`, the uid
  # that owns every provider credential. The safe path was down and the unsafe
  # one was carrying the traffic.
  #
  # The former `~/.hermes/mcp-terminal.yaml` sidecar written here was inert;
  # Hermes reads config.yaml, so it was never merged and only made the real
  # failure harder to see. Deleted rather than left as a decoy.
  rm -f "$HOME_DIR/.hermes/mcp-terminal.yaml"
  /opt/hermes-venv/bin/python - "$HOME_DIR/.hermes/config.yaml" <<'MCPEOF' >> "$LOG_FILE" 2>&1 || true
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
SERVER = "/usr/local/bin/mcp-terminal-server.js"
try:
    cfg = yaml.safe_load(p.read_text()) if p.exists() else {}
except Exception as e:
    print(f"[startup] divinci_terminal: config unreadable ({e}) — NOT registered")
    raise SystemExit(0)
if not isinstance(cfg, dict):
    cfg = {}
servers = cfg.get("mcp_servers")
if not isinstance(servers, dict):
    servers = {}
# Replace this server's entry wholesale (it is ours), but preserve every other
# server — fulcrum is registered separately and must survive.
servers["divinci_terminal"] = {
    "command": "node",
    "args": [SERVER],
    "enabled": True,
    "timeout": 620,
}
cfg["mcp_servers"] = servers
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False))

# Read back from disk and assert the TYPE — the whole failure was a value that
# was present, well-formed to the eye, and of the wrong type. A log line
# reporting what we attempted rather than what is true is what let this run for
# months.
check = yaml.safe_load(p.read_text()) or {}
got = ((check.get("mcp_servers") or {}).get("divinci_terminal") or {}).get("args")
ok = isinstance(got, list) and got == [SERVER]
print(
    f"[startup] divinci_terminal args={'OK' if ok else 'FAILED'} "
    f"type={type(got).__name__} value={got!r}"
)
MCPEOF
  echo "[startup] registered divinci_terminal MCP server (bounded terminal)" >> "$LOG_FILE"
fi

# ── Fulcrum MCP (remote HTTP) ───────────────────────────────────────────────
#
# Divinci dogfood only. Fulcrum exposes ~130 tools including execute_command /
# write_file — a token is code execution on the Fulcrum host. Gated off unless
# HERMES_FULCRUM_MCP_ENABLED=true and never intended for multi-tenant customer
# agents.
#
# Hermes resolves ${env:VAR} in headers from ~/.hermes/.env (written above), so
# the token never needs to be interpolated into config.yaml as plaintext in a
# loggable config-set argv. Optional CF Access service-token headers for when
# Access is enforced on fulcrum-acme.divinci.ai.
if [ "${HERMES_FULCRUM_MCP_ENABLED:-false}" = "true" ] || [ "${HERMES_FULCRUM_MCP_ENABLED:-}" = "1" ]; then
  FULCRUM_URL="${FULCRUM_MCP_URL:-https://fulcrum-acme.divinci.ai/mcp}"
  # Materialize token into the hermes env file (0600) for ${env:FULCRUM_API_TOKEN}.
  if [ -n "${FULCRUM_API_TOKEN:-}" ]; then
    # Drop any prior line then append (idempotent across soft restarts).
    if [ -f "$HERMES_ENV_FILE" ]; then
      grep -vE '^FULCRUM_API_TOKEN=' "$HERMES_ENV_FILE" > "${HERMES_ENV_FILE}.nofulcrum" 2>/dev/null \
        || cp "$HERMES_ENV_FILE" "${HERMES_ENV_FILE}.nofulcrum"
      cat "${HERMES_ENV_FILE}.nofulcrum" > "$HERMES_ENV_FILE"
      rm -f "${HERMES_ENV_FILE}.nofulcrum"
    fi
    printf 'FULCRUM_API_TOKEN=%s\n' "${FULCRUM_API_TOKEN}" >> "$HERMES_ENV_FILE"
    chmod 600 "$HERMES_ENV_FILE"
  fi
  if [ -n "${FULCRUM_CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${FULCRUM_CF_ACCESS_CLIENT_SECRET:-}" ]; then
    printf 'FULCRUM_CF_ACCESS_CLIENT_ID=%s\n' "${FULCRUM_CF_ACCESS_CLIENT_ID}" >> "$HERMES_ENV_FILE"
    printf 'FULCRUM_CF_ACCESS_CLIENT_SECRET=%s\n' "${FULCRUM_CF_ACCESS_CLIENT_SECRET}" >> "$HERMES_ENV_FILE"
    chmod 600 "$HERMES_ENV_FILE"
  fi

  # Write a snippet Hermes can merge; hermes config set for scalar fields.
  # Never echo the token. URL only in logs.
  hermes config set mcp_servers.fulcrum.url "${FULCRUM_URL}" >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.fulcrum.enabled true >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.fulcrum.timeout 120 >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.fulcrum.connect_timeout 30 >> "$LOG_FILE" 2>&1 || true
  # Fulcrum's GET/HEAD returns SPA HTML (or CF Access HTML). Hermes preflight
  # then refuses the server; skip it — the Streamable HTTP POST is valid.
  hermes config set mcp_servers.fulcrum.skip_preflight true >> "$LOG_FILE" 2>&1 || true
  # Prefer ${env:} expansion so the secret stays in .env, not config.yaml.
  if [ -n "${FULCRUM_API_TOKEN:-}" ]; then
    hermes config set mcp_servers.fulcrum.headers.Authorization 'Bearer ${env:FULCRUM_API_TOKEN}' >> "$LOG_FILE" 2>&1 || true
  fi
  if [ -n "${FULCRUM_CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${FULCRUM_CF_ACCESS_CLIENT_SECRET:-}" ]; then
    hermes config set mcp_servers.fulcrum.headers.CF-Access-Client-Id '${env:FULCRUM_CF_ACCESS_CLIENT_ID}' >> "$LOG_FILE" 2>&1 || true
    hermes config set mcp_servers.fulcrum.headers.CF-Access-Client-Secret '${env:FULCRUM_CF_ACCESS_CLIENT_SECRET}' >> "$LOG_FILE" 2>&1 || true
  fi
  # Also drop a durable yaml snippet (docs + recovery if config set partial-fails).
  cat > "$HOME_DIR/.hermes/mcp-fulcrum.yaml" <<FULCRUMEOF
# Generated by start-hermes.sh — do not commit. Token via \${env:FULCRUM_API_TOKEN}.
mcp_servers:
  fulcrum:
    url: "${FULCRUM_URL}"
    enabled: true
    timeout: 120
    connect_timeout: 30
    skip_preflight: true
    headers:
      Authorization: "Bearer \${env:FULCRUM_API_TOKEN}"
FULCRUMEOF
  chmod 600 "$HOME_DIR/.hermes/mcp-fulcrum.yaml" 2>/dev/null || true
  if [ -n "${FULCRUM_API_TOKEN:-}" ]; then
    echo "[startup] registered fulcrum MCP -> ${FULCRUM_URL} (token=set)" >> "$LOG_FILE"
  else
    echo "[startup] registered fulcrum MCP -> ${FULCRUM_URL} (token=MISSING — tools may work if Fulcrum allows unauthenticated MCP)" >> "$LOG_FILE"
  fi
else
  echo "[startup] fulcrum MCP NOT registered (HERMES_FULCRUM_MCP_ENABLED!=true)" >> "$LOG_FILE"
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
