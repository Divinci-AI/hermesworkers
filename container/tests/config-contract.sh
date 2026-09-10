#!/usr/bin/env bash
#
# The config contract, executed INSIDE the real image.
#
# ⚠️ THIS IS THE ONLY TEST IN THIS REPO THAT RUNS ANYTHING.
#
# Every other guard asserts on start-hermes.sh's TEXT. None executes it, and
# none knows which Hermes the image pins — so none of them could catch, and
# none of them did catch, either of the two production outages this file exists
# to prevent:
#
#   1. `hermes config set model "<id>"` — SUCCEEDS (exit 0, prints a ✓) and
#      DESTROYS the mapping: `model` is {default, provider, base_url} and that
#      writes a scalar over all three. The gateway then had no provider and no
#      base_url, could not resolve the `cfai/` prefix, fell through to a Gemini
#      default and 404'd on every turn — surfacing as an unrelated httpx
#      exception because the error summariser crashes on a streaming response.
#
#      ⚠️ This was first diagnosed as "the set is REJECTED", inferred from a
#      missing `✓ Set model` line in the boot log. That line was missing because
#      the model set lacked the `>> "$LOG_FILE" 2>&1` its neighbours had — not
#      because anything failed. THIS FILE FOUND THAT, within minutes of first
#      running, by executing the command instead of reasoning about it.
#
#   2. `hermes config get model` — DOES NOT EXIST on the pinned CLI. The
#      read-back written to fix (1) was verified on a laptop's v0.20.0, and in
#      production logged argparse's usage text AS THE VALUE.
#
# Both are version-dependent facts about a binary. They are unreachable from
# any static assertion and obvious from one `docker run`.
#
# It deliberately does NOT boot the gateway: start-hermes.sh ends in
# `exec hermes gateway`, which blocks and wants network, secrets and a live
# Cloudflare account. What it pins is the contract start-hermes.sh depends on.
set -uo pipefail

HOME_DIR="$(mktemp -d)"
export HERMES_HOME="$HOME_DIR"
CFG="$HOME_DIR/config.yaml"
fails=0

ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; fails=$((fails+1)); }

echo "hermes: $(hermes --version 2>&1 | head -1)"

# ── 1. the leaves start-hermes.sh writes must be settable ──────────────────
if hermes config set model.default "@cf/deepseek-ai/deepseek-v4-flash-0731" >/dev/null 2>&1; then
  ok "config set model.default accepted"
else
  bad "config set model.default REJECTED — start-hermes.sh cannot pin a model"
fi

if hermes config set model.provider "cfai" >/dev/null 2>&1; then
  ok "config set model.provider accepted"
else
  bad "config set model.provider REJECTED — the provider half of the pin is lost"
fi

# ── 2. …and must actually LAND in the file the gateway reads ───────────────
# A ✓ from `config set` proves a key was WRITTEN, not that the path is one
# anything reads — that is how `model.providers.cfai` was set, ✓'d, and
# resolved to nothing. So assert against the file, parsed.
read_back="$(/opt/hermes-venv/bin/python - "$CFG" <<'PY' 2>&1
import sys, yaml
try:
    cfg = yaml.safe_load(open(sys.argv[1])) or {}
    m = cfg.get("model")
    if not isinstance(m, dict):
        print(f"UNEXPECTED model is {type(m).__name__}: {m!r}")
    else:
        print(f"default={m.get('default')!r} provider={m.get('provider')!r}")
except Exception as exc:
    print(f"UNREADABLE {type(exc).__name__}: {exc}")
PY
)"
echo "  read_back: $read_back"

case "$read_back" in
  *"default='@cf/deepseek-ai/deepseek-v4-flash-0731'"*) ok "model.default landed in config.yaml" ;;
  *) bad "model.default did NOT land — got: $read_back" ;;
esac
case "$read_back" in
  *"provider='cfai'"*) ok "model.provider landed in config.yaml" ;;
  *) bad "model.provider did NOT land — got: $read_back" ;;
esac

# ── 3. the read-back must not depend on a subcommand that may not exist ────
# Not "does `get` exist" — we do not care, and caring is what broke it. We care
# that the reporting path works on THIS image whatever the CLI offers.
case "$read_back" in
  usage:*|*"invalid choice"*|*"error: argument"*)
     bad "read-back returned CLI usage text — it is reporting an argparse error as a value" ;;
  "") bad "read-back was EMPTY — reads as 'nothing is set', a wrong answer in the right shape" ;;
  *) ok "read-back returned a value, not a diagnostic" ;;
esac

# ── 4. the approval posture must be settable, for the same reason ──────────
# start-hermes.sh sets these with `|| true`. They are security controls, and a
# silently-rejected set degrades the posture with no signal.
for pair in "approvals.mode manual" "approvals.cron_mode deny"; do
  set -- $pair
  if hermes config set "$1" "$2" >/dev/null 2>&1; then ok "config set $1 accepted"
  else bad "config set $1 REJECTED — approval posture would degrade silently"; fi
done

rm -rf "$HOME_DIR"
if [ "$fails" -ne 0 ]; then
  echo "FAILED: $fails config-contract assertion(s)"; exit 1
fi
echo "config contract OK"
