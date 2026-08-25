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
    # Replace only the keys the panel OWNS, then append the durable file.
    #
    # This used to be a blanket `grep -vE '^SLACK_'`, which made every boot
    # delete SLACK_* keys the panel does not model — including the home channel
    # that Hermes' own `/sethome` had just written into this same file
    # (gateway/slash_commands.py::_handle_set_home_command calls
    # save_env_value("SLACK_HOME_CHANNEL", ...)). The result was that
    # `/sethome` appeared to work and then silently did not survive a restart,
    # while the panel reported the agent as applied and live.
    #
    # The rule, identical to slackOwnedKeyStripPattern() in
    # src/lib/slack-platform.ts, is derived from the durable file itself so the
    # two cannot drift: strip the unconditionally-owned keys, plus whatever
    # slack.env actually sets, plus SLACK_HOME_CHANNEL_THREAD_ID when (and only
    # when) slack.env sets a home channel. Preserve everything else.
    SLACK_OWNED='SLACK_BOT_TOKEN|SLACK_APP_TOKEN|SLACK_ALLOW_ALL_USERS|SLACK_ALLOWED_USERS|SLACK_ALLOWED_CHANNELS|SLACK_FREE_RESPONSE_CHANNELS'
    SLACK_FILE_KEYS="$(sed -nE 's/^(SLACK_[A-Z0-9_]+)=.*/\1/p' "$SLACK_PLATFORM_ENV" | sort -u | tr '\n' '|' | sed 's/|$//')"
    if [ -n "$SLACK_FILE_KEYS" ]; then
        SLACK_OWNED="${SLACK_OWNED}|${SLACK_FILE_KEYS}"
    fi
    if grep -qE '^SLACK_HOME_CHANNEL=' "$SLACK_PLATFORM_ENV"; then
        SLACK_OWNED="${SLACK_OWNED}|SLACK_HOME_CHANNEL_NAME|SLACK_HOME_CHANNEL_THREAD_ID"
    fi
    # grep exits 1 when it selects NO lines, which here is a legitimate result
    # (the live .env held nothing but owned keys). The previous `|| cp` fallback
    # could not tell that apart from a real error and restored the file it had
    # just filtered — so a live .env consisting only of owned keys came through
    # completely unfiltered. Only exit >1 is an actual grep failure.
    set +e
    grep -vE "^(${SLACK_OWNED})=" "$HERMES_ENV_FILE" > "${HERMES_ENV_FILE}.noslack" 2>/dev/null
    SLACK_GREP_RC=$?
    set -e
    if [ "$SLACK_GREP_RC" -gt 1 ]; then
        cp "$HERMES_ENV_FILE" "${HERMES_ENV_FILE}.noslack"
    fi
    cat "${HERMES_ENV_FILE}.noslack" "$SLACK_PLATFORM_ENV" > "$HERMES_ENV_FILE"
    rm -f "${HERMES_ENV_FILE}.noslack"
    echo "[startup] merged Slack platform env from $SLACK_PLATFORM_ENV (owned=${SLACK_OWNED})" >> "$LOG_FILE"
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
# Last-resort default. Deliberately a PLATFORM (`cfai/`) id, not a BYOK one:
# this fires when an agent has no per-agent pin AND the Worker sets no
# HERMES_DEFAULT_MODEL, and `anthropic/claude-sonnet-4-5` needed an
# ANTHROPIC_API_KEY that such a Worker has no reason to hold — so the fallback
# could only ever fail. `cfai/@cf/…` runs on Divinci's own Workers AI creds,
# which is the same pair the cfai provider above is registered from.
EFFECTIVE_MODEL="${AGENT_MODEL:-${HERMES_DEFAULT_MODEL:-cfai/@cf/deepseek-ai/deepseek-v4-flash-0731}}"
# ⚠️ SET `model.default`, NOT BARE `model`, AND REPORT WHAT THE CONFIG HOLDS.
#
# `model` is a MAPPING in config.yaml (`default` / `provider` / `base_url`), so
# `hermes config set model "<id>"` writes a scalar over a mapping. Newer CLIs
# (v0.20.0 / 2026.8.3) silently repair that — "Redirecting bare 'model' to
# 'model.default'" — but the pinned container CLI (HERMES_VERSION=v2026.7.7.2)
# does NOT, and rejects it.
#
# That rejection was invisible twice over: `|| true` swallowed the exit code,
# and the `echo` below printed $EFFECTIVE_MODEL whether or not it was stored.
# So on 2026-08-25 the boot log asserted
# `model=cfai/@cf/deepseek-ai/deepseek-v4-pro-0813` while config.yaml still held
# a Gemini model, every turn routed through gemini_native_adapter, and Gemini
# answered 404 — surfacing as an httpx `ResponseNotRead` because the error
# summariser crashes reading `.text` on a streaming response.
#
# The tell was ABSENCE: `hermes config set` prints `✓ Set <key> = <value>` on
# success, and the two `providers.cfai.*` sets immediately above printed theirs
# while `model` printed nothing.
#
# So: no `|| true`, and the log line reports `hermes config get model` — the
# stored value — rather than echoing this script's own input. A log line that
# restates its input cannot detect this class of failure, which is exactly how
# it survived.
# ⚠️ SPLIT THE PROVIDER OUT — `model.default` ALONE IS NOT ENOUGH.
#
# `model` has THREE leaves: default / provider / base_url. Setting only
# `model.default` to a provider-prefixed id (`cfai/@cf/deepseek-ai/…`) leaves no
# provider anywhere in the mapping and rests entirely on the CLI splitting on
# the first slash — which nothing has ever verified on the PINNED CLI.
#
# The one configuration measured serving a real turn (Hermes Local, 2026-08-25)
# is the split form:
#
#     model:
#       default:  '@cf/deepseek-ai/deepseek-v4-flash-0731'   # BARE
#       provider: cfai
#       base_url: https://api.cloudflare.com/…/ai/v1
#
# base_url is already covered by the providers.cfai registration above.
#
# ⚠️ VERIFIED ON v0.20.0 (2026.8.3), NOT ON THE PINNED v2026.7.7.2. The SHAPE is
# what was confirmed, by setting all three leaves explicitly — not the newer
# CLI's bare-`model` redirect. `model_stored=` below is what tells us whether
# the pinned CLI accepts `model.provider` at all; do not assume it from this
# comment.
#
# The no-slash case is guarded so a bare id (`gemini-2.5-flash`) is not mangled
# into an empty provider — `${x%%/*}` and `${x#*/}` both return the whole string
# when there is no slash, which would set provider and model to the same value.
if [ "$EFFECTIVE_MODEL" != "${EFFECTIVE_MODEL#*/}" ]; then
  MODEL_PROVIDER="${EFFECTIVE_MODEL%%/*}"
  MODEL_ID="${EFFECTIVE_MODEL#*/}"
else
  MODEL_PROVIDER=""
  MODEL_ID="$EFFECTIVE_MODEL"
fi

if ! hermes config set model.default "$MODEL_ID" >> "$LOG_FILE" 2>&1; then
  echo "[startup] ⚠️ FAILED to set model.default=$MODEL_ID — the turn model is NOT what this boot intended" >> "$LOG_FILE"
fi
if [ -n "$MODEL_PROVIDER" ]; then
  if ! hermes config set model.provider "$MODEL_PROVIDER" >> "$LOG_FILE" 2>&1; then
    echo "[startup] ⚠️ FAILED to set model.provider=$MODEL_PROVIDER — the turn model is NOT what this boot intended" >> "$LOG_FILE"
  fi
fi
echo "[startup] model_requested=$EFFECTIVE_MODEL (per-agent=${AGENT_MODEL:-none})" >> "$LOG_FILE"
echo "[startup] model_stored=$(hermes config get model 2>&1 | tr '\n' ' ')" >> "$LOG_FILE"

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

# ── Remove built-in toolsets that run as the CREDENTIAL-OWNING uid ─────────
#
# The comment further down used to claim "Hermes' own command execution is
# disabled above". It was not — nothing disabled it, and `approvals.mode` does
# not, because that is a SHELL COMMAND gate with exactly two consumers
# (check_all_command_guards, check_execute_code_guard).
#
# The real exposure is not the terminal, it is `read_file`. Slack's default
# toolset `hermes-slack` carries the whole `file` toolset — read_file,
# write_file, patch, search_files — and those are BUILT-INS, so they run as
# `hermes`, the uid that owns ~/.hermes/. Therefore:
#
#     read_file(path="~/.hermes/.env")
#
# returns every provider credential in ONE call, with no approval prompt and no
# dangerous-pattern match. `file_tools.py` does have a sensitive-path system —
# it even refuses to overwrite config.yaml so an injected agent cannot turn
# approvals off — but both of its call sites are in the WRITE and PATCH
# handlers. Reads are unchecked, and `.env` is not on the list anyway.
#
# This is a strictly simpler form of the 2026-07-27 incident and it survives
# every control added since.
#
# Capability is not being removed, only re-routed: the bounded terminal
# (divinci_terminal, below) supplies terminal_exec / read_file / write_file /
# list_files / git_clone as uid 10002, confined to /workspace, with iptables
# egress allowlisting. Both halves verified in production 2026-08-14 —
# `.env` and `config.yaml` DENIED to that uid, and example.com / api.openai.com
# unreachable while npm and github resolve. The two controls compose: the uid
# that can reach the network is the one that cannot read the secrets.
#
# Known losses: `patch` and `process` have no bounded equivalent, and file
# access outside /workspace goes away.
#
# ⚠️ LIST-VALUED, so it is written as YAML — `hermes config set` would store a
# string, which is the bug that silently disabled the plugin AND the bounded
# terminal. Read back and log the parsed type.
#
# Unset by default: an environment that does not opt in behaves exactly as
# before. Staging carries it first.
if [ -n "${HERMES_DISABLED_TOOLSETS:-}" ]; then
  /opt/hermes-venv/bin/python - "$HOME_DIR/.hermes/config.yaml" "${HERMES_DISABLED_TOOLSETS}" <<'DTEOF' >> "$LOG_FILE" 2>&1 || true
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
wanted = [t.strip() for t in sys.argv[2].split(",") if t.strip()]
try:
    cfg = yaml.safe_load(p.read_text()) if p.exists() else {}
except Exception as e:
    print(f"[startup] disabled_toolsets: config unreadable ({e}) — NOT applied")
    raise SystemExit(0)
if not isinstance(cfg, dict):
    cfg = {}
# gateway/run.py reads `agent.disabled_toolsets`; preserve the rest of `agent`.
agent = cfg.get("agent")
if not isinstance(agent, dict):
    agent = {}
agent["disabled_toolsets"] = wanted
cfg["agent"] = agent
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False))

check = yaml.safe_load(p.read_text()) or {}
got = (check.get("agent") or {}).get("disabled_toolsets")
ok = isinstance(got, list) and got == wanted
print(
    f"[startup] disabled_toolsets={'OK' if ok else 'FAILED'} "
    f"type={type(got).__name__} value={got!r}"
)
DTEOF
else
  echo "[startup] disabled_toolsets=UNSET — built-in terminal/file tools remain available" >> "$LOG_FILE"
fi

# ── Slack toolset ALLOWLIST ────────────────────────────────────────────────
#
# ⚠️ THE DENYLIST ABOVE IS NOT SUFFICIENT ON ITS OWN, and this is why.
#
# `disabled_toolsets="terminal,file"` shipped on 2026-08-14 to stop the agent
# reading ~/.hermes/.env. A Slack smoke test read it anyway, in one turn, via
# `execute_code` — a THIRD toolset (`code_execution`) that the denylist did not
# name. Naming two more would not have fixed the shape: `hermes-slack` also
# carries browser_exec, browser_cdp, computer_use, cronjob, delegate_task and
# skill_manage.
#
# So this is an ALLOWLIST, for the same reason the email guard's
# UNATTENDED_ALLOWED_TOOLS is one: a toolset added to Hermes tomorrow is denied
# by default rather than silently inheriting access. A denylist has to be
# updated in lockstep with every upstream release to stay correct, and fails
# OPEN when it isn't.
#
# `gateway/run.py` reads `platform_toolsets.<platform>` per platform, so this
# scopes Slack without touching any other path.
#
# What Slack keeps: web search/extract, vision, image + video generation,
# skills, memory, todo, clarify, session_search, kanban, TTS — 32 tools — plus
# every MCP tool, which toolsets do not govern. The bounded terminal
# (divinci_terminal) is an MCP server, so shell and file work SURVIVE this,
# routed through uid 10002 in /workspace.
#
# What it removes beyond the denylist: execute_code, computer_use, cronjob,
# delegate_task, all browser_* and homeassistant. The browser tools are no loss
# in practice — there is no browser binary in this image (checked 2026-08-14:
# no chromium/chrome/playwright anywhere) — but they carry browser_exec and
# browser_cdp, which are code execution and a plausible file-read path.
# delegate_task is excluded because a sub-agent may resolve its own toolset,
# which would route around everything here.
#
# Verified when composed: the resulting set grants NOTHING that hermes-slack
# did not already have. An allowlist that accidentally widens is its own bug.
#
# ⚠️ LIST-VALUED (nested under a dict), so YAML, never `hermes config set`.
if [ -n "${HERMES_SLACK_TOOLSETS:-}" ]; then
  /opt/hermes-venv/bin/python - "$HOME_DIR/.hermes/config.yaml" "${HERMES_SLACK_TOOLSETS}" <<'PTEOF' >> "$LOG_FILE" 2>&1 || true
import sys, pathlib, yaml
p = pathlib.Path(sys.argv[1])
wanted = [t.strip() for t in sys.argv[2].split(",") if t.strip()]
try:
    cfg = yaml.safe_load(p.read_text()) if p.exists() else {}
except Exception as e:
    print(f"[startup] platform_toolsets.slack: config unreadable ({e}) — NOT applied")
    raise SystemExit(0)
if not isinstance(cfg, dict):
    cfg = {}
pt = cfg.get("platform_toolsets")
if not isinstance(pt, dict):
    pt = {}
pt["slack"] = wanted          # other platforms keep whatever they had
cfg["platform_toolsets"] = pt
p.parent.mkdir(parents=True, exist_ok=True)
p.write_text(yaml.safe_dump(cfg, default_flow_style=False, sort_keys=False))

check = yaml.safe_load(p.read_text()) or {}
got = (check.get("platform_toolsets") or {}).get("slack")
ok = isinstance(got, list) and got == wanted
print(
    f"[startup] platform_toolsets.slack={'OK' if ok else 'FAILED'} "
    f"type={type(got).__name__} count={len(got) if isinstance(got, list) else 'n/a'} value={got!r}"
)
PTEOF
else
  echo "[startup] platform_toolsets.slack=UNSET — Slack keeps the FULL hermes-slack toolset (execute_code included)" >> "$LOG_FILE"
fi

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
# Hermes' own command execution runs as the credential-owning uid, so the agent
# gets the bounded terminal as an MCP server instead: same capability, routed
# THROUGH the security boundary rather than around it.
#
# ⚠️ This comment used to assert that Hermes' own command execution "is
# disabled above". It was not, and had never been — nothing in this script
# disabled it, and `approvals.mode` cannot, being a shell-command gate. The
# claim was load-bearing in the worst way: it made the built-in terminal and
# `read_file` look already-handled, so nobody looked at them for months.
# Disabling them is `HERMES_DISABLED_TOOLSETS` above, and it is opt-in per
# environment — so on an environment that has not set it, they ARE still
# available, and this comment must not imply otherwise.
#
# Every tool it exposes executes as hermes-term (uid 10002) via the narrow
# sudo grant — a user that cannot read ~/.hermes/, starts from an empty
# environment, and whose egress is REJECTed except through the guard.
#
# Gated on HERMES_TERMINAL_ENABLED so a deployment that has not established the
# boundary (setup-terminal.sh not run, or NET_ADMIN unavailable) does not
# advertise tools that would fail on every call.
# ── ESTABLISH THE BOUNDARY FIRST, AND REFUSE THE TOOL IF IT FAILS ─────────
#
# setup-terminal.sh's own header says it must run "ONCE at container boot, as
# root, BEFORE any terminal command is accepted". It did not: the only caller
# was `ensureTerminalBoundary()` in the WORKER (src/lib/terminal.ts), which
# runs on the Worker's /api/terminal route. The agent does not use that route
# — it uses `mcp-terminal-server.js`, which spawns
# `sudo -u hermes-term hermes-term-exec` directly inside this container.
#
# So the boundary was never established on the path that actually carries
# traffic, and the failure was invisible: commands worked, `id` reported uid
# 10002, and the allowlist appeared to be enforced because HTTP_PROXY was set.
# Measured in production 2026-08-21: `curl --noproxy "*" https://example.com`
# returned 200, nothing listened on :3128, and OUTPUT had no rules at all.
# The proxy env vars are advisory — any client discards them with one flag.
#
# Running it here closes that, and the ORDER is the control: if the boundary
# cannot be established, the MCP server is not registered at all, so the agent
# has no terminal rather than an unbounded one. That is the fail-closed posture
# the script's header promises ("There is no degraded mode").
#
# ⚠️ Deliberately NOT fatal to the container. A container that refuses to boot
# takes Slack and chat down with it, which is a worse failure than losing one
# tool — the same trade already made for the email guard above. The loss is
# loud instead: this line is the signal that the terminal is gone and why.
TERMINAL_BOUNDARY_OK=false
if [ "${HERMES_TERMINAL_ENABLED:-false}" = "true" ]; then
  if EGRESS_ALLOWED_HOSTS="${EGRESS_ALLOWED_HOSTS:-}"      EGRESS_PROXY_PORT="${EGRESS_PROXY_PORT:-3128}"      /usr/local/bin/setup-terminal.sh >> "$LOG_FILE" 2>&1; then
    TERMINAL_BOUNDARY_OK=true
    echo "[startup] terminal boundary ESTABLISHED (egress guard + owner-match lockdown)" >> "$LOG_FILE"
  else
    echo "[startup] ⛔ terminal boundary FAILED — divinci_terminal will NOT be registered; the agent gets no terminal. See setup-terminal output above." >> "$LOG_FILE"
  fi
fi

if [ "${HERMES_TERMINAL_ENABLED:-false}" = "true" ] && [ "$TERMINAL_BOUNDARY_OK" = "true" ]; then
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

# ── Buffer MCP (remote HTTP) ───────────────────────────────────────────────
#
# Divinci dogfood only. Used to drain the changelog idea column onto LinkedIn
# and X via addToQueue. Gated off unless HERMES_BUFFER_MCP_ENABLED=true.
# Hermes resolves ${env:VAR} in headers from ~/.hermes/.env, so the Personal
# Access key never needs to land in config.yaml as plaintext in a loggable
# config-set argv.
if [ "${HERMES_BUFFER_MCP_ENABLED:-false}" = "true" ] || [ "${HERMES_BUFFER_MCP_ENABLED:-}" = "1" ]; then
  BUFFER_URL="https://mcp.buffer.com/mcp"
  if [ -n "${MCP_BUFFER_API_KEY:-}" ]; then
    if [ -f "$HERMES_ENV_FILE" ]; then
      grep -vE '^MCP_BUFFER_API_KEY=' "$HERMES_ENV_FILE" > "${HERMES_ENV_FILE}.nobuffer" 2>/dev/null \
        || cp "$HERMES_ENV_FILE" "${HERMES_ENV_FILE}.nobuffer"
      cat "${HERMES_ENV_FILE}.nobuffer" > "$HERMES_ENV_FILE"
      rm -f "${HERMES_ENV_FILE}.nobuffer"
    fi
    printf 'MCP_BUFFER_API_KEY=%s\n' "${MCP_BUFFER_API_KEY}" >> "$HERMES_ENV_FILE"
    chmod 600 "$HERMES_ENV_FILE"
  fi
  hermes config set mcp_servers.buffer.url "${BUFFER_URL}" >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.buffer.enabled true >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.buffer.timeout 120 >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.buffer.connect_timeout 30 >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.buffer.skip_preflight true >> "$LOG_FILE" 2>&1 || true
  if [ -n "${MCP_BUFFER_API_KEY:-}" ]; then
    hermes config set mcp_servers.buffer.headers.Authorization 'Bearer ${env:MCP_BUFFER_API_KEY}' >> "$LOG_FILE" 2>&1 || true
    echo "[startup] registered buffer MCP -> ${BUFFER_URL} (token=set)" >> "$LOG_FILE"
  else
    echo "[startup] registered buffer MCP -> ${BUFFER_URL} (token=MISSING — changelog queue duty cannot run)" >> "$LOG_FILE"
  fi
else
  echo "[startup] buffer MCP NOT registered (HERMES_BUFFER_MCP_ENABLED!=true)" >> "$LOG_FILE"
fi

# ── Canva MCP (remote HTTP, OAuth) ─────────────────────────────────────────
#
# Divinci dogfood only. Gives the agent Canva's ~33 design tools so the
# outreach deck for a prospect can be BUILT rather than specced. Gated off
# unless HERMES_CANVA_MCP_ENABLED=true.
#
# ⚠️ Canva has NO static API key, so this cannot follow the Buffer shape (a
# Bearer header out of .env). The only credential is an OAuth grant whose
# access token lives 4 HOURS — an always-on agent must therefore hold the
# refresh_token and let Hermes refresh on its own. We seed the token files and
# register with `auth: oauth`; Hermes owns every refresh after that.
#
# ⚠️ The seeded grant must be its OWN authorization, not a copy of the laptop
# gateway's. Canva issues single-use refresh tokens: two holders of one grant
# race on refresh and the loser gets invalid_grant — with no browser in a
# container, it can never re-consent, and the tools simply vanish.
#
# ⚠️ There is no interactive fallback here BY CONSTRUCTION. If the refresh is
# ever rejected, Hermes parks the server and the failure is silent from the
# outside (an agent with no Canva tools just stops mentioning Canva). The
# startup line below is the only cheap signal that the seed landed; grep the
# boot log for `canva MCP` whenever the deck builds go quiet.
if [ "${HERMES_CANVA_MCP_ENABLED:-false}" = "true" ] || [ "${HERMES_CANVA_MCP_ENABLED:-}" = "1" ]; then
  CANVA_URL="https://mcp.canva.com/mcp"
  CANVA_SEEDED="no"
  if [ -n "${MCP_CANVA_OAUTH_JSON:-}" ]; then
    # The secret reaches python through the ENVIRONMENT, never argv: argv is
    # world-readable via `ps`, and this value is a refresh_token.
    #
    # ⚠️ It cannot come over stdin either, however obvious that looks: the
    # script itself is fed to `python -` by the heredoc below, so a
    # `printf … | python - <<EOF` reads the HEREDOC on stdin and the piped JSON
    # is silently discarded. That wrote no files at all and still logged a
    # tidy-looking seed=MISSING line.
    if /opt/hermes-venv/bin/python - \
         "$HOME_DIR/.hermes/mcp-tokens" >> "$LOG_FILE" 2>&1 <<'CANVAEOF'
import json, os, sys, time

token_dir = sys.argv[1]
seed = json.loads(os.environ["MCP_CANVA_OAUTH_JSON"])

client_id = seed.get("client_id")
refresh_token = seed.get("refresh_token")
if not client_id or not refresh_token:
    # Fail loudly rather than writing a file that looks seeded and is not:
    # a token file missing refresh_token dies four hours later, long after
    # anyone is still looking at this boot.
    raise SystemExit("MCP_CANVA_OAUTH_JSON needs client_id and refresh_token")

os.makedirs(token_dir, mode=0o700, exist_ok=True)

tokens = {
    "access_token": seed.get("access_token", ""),
    "token_type": seed.get("token_type", "Bearer"),
    "refresh_token": refresh_token,
    # Default to already-expired so the first connect refreshes instead of
    # presenting a stale access_token and reading the 401 as a dead grant.
    "expires_at": float(seed.get("expires_at", 0)),
}
if seed.get("scope"):
    tokens["scope"] = seed["scope"]
if seed.get("expires_in"):
    tokens["expires_in"] = seed["expires_in"]

client = {
    "client_id": client_id,
    "redirect_uris": seed.get("redirect_uris", ["http://127.0.0.1:37949/callback"]),
    "token_endpoint_auth_method": seed.get("token_endpoint_auth_method", "none"),
    "grant_types": ["authorization_code", "refresh_token"],
    "response_types": ["code"],
    "client_name": seed.get("client_name", "Hermes Agent"),
}
if seed.get("client_secret"):
    client["client_secret"] = seed["client_secret"]

for name, payload in (("canva.json", tokens), ("canva.client.json", client)):
    path = os.path.join(token_dir, name)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(payload, fh)

age = "expired" if tokens["expires_at"] <= time.time() else "live"
print(f"[startup] canva OAuth seed written (client_id set, access_token {age})")
CANVAEOF
    then
      CANVA_SEEDED="yes"
      chmod 700 "$HOME_DIR/.hermes/mcp-tokens" 2>/dev/null || true
    fi
  fi
  hermes config set mcp_servers.canva.url "${CANVA_URL}" >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.canva.enabled true >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.canva.auth oauth >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.canva.timeout 120 >> "$LOG_FILE" 2>&1 || true
  # 60s, not Buffer's 30: Canva's handshake lists 33 tools and can fold a token
  # refresh into the same connect. A laptop gateway measured 0.6s warm and 6.5s
  # cold, and 30s upstream timeouts were what wedged it on 2026-08-24.
  hermes config set mcp_servers.canva.connect_timeout 60 >> "$LOG_FILE" 2>&1 || true
  hermes config set mcp_servers.canva.skip_preflight true >> "$LOG_FILE" 2>&1 || true
  if [ "$CANVA_SEEDED" = "yes" ]; then
    echo "[startup] registered canva MCP -> ${CANVA_URL} (oauth seed=OK)" >> "$LOG_FILE"
  else
    echo "[startup] registered canva MCP -> ${CANVA_URL} (oauth seed=MISSING — no browser in here, so the tools will NOT appear)" >> "$LOG_FILE"
  fi
else
  echo "[startup] canva MCP NOT registered (HERMES_CANVA_MCP_ENABLED!=true)" >> "$LOG_FILE"
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
# MEDIA delivery allowlist. The gateway refuses to attach a model-emitted file
# unless it sits under an allowed root (gateway/platforms/base.py,
# _media_delivery_allowed_roots). /workspace is not a built-in root, so every
# artifact the terminal produced was refused as an "unsafe MEDIA directive
# path" — while the only directory the gateway COULD read, /home/hermes, was
# refused for the same reason. That left no path from "the terminal made an
# image" to "Slack received it". Pairs with the group/setgid change in
# setup-terminal.sh: this makes /workspace ALLOWED, that makes it READABLE, and
# the handoff needs both.
export HERMES_MEDIA_ALLOW_DIRS="${HERMES_MEDIA_ALLOW_DIRS:-/workspace}"
echo "[startup] media_allow_dirs=${HERMES_MEDIA_ALLOW_DIRS}" >> "$LOG_FILE"

# Image marker. Bump on every container image change: an evict that did not
# take cold-boots the OLD image while reporting success, and a changed startup
# line is the only cheap way to tell the two apart. Grep for the NAME, not the
# value — an absent line reads as a clean run.
echo "[startup] image_marker=2026-08-24-terminal-breaker-and-workspace-group" >> "$LOG_FILE"

echo "=== $(date -u) launching hermes gateway (user=${RUN_USER}) ===" >> "$LOG_FILE"
exec gosu "${RUN_USER}" hermes gateway >> "$LOG_FILE" 2>&1
