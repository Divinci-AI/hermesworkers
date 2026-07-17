#!/usr/bin/env bash
# Live FUNCTIONAL proof against a real-Hermes hosted deploy: two agents each
# (1) boot the gateway as a NON-ROOT user, and (2) answer a chat completion.
# Isolation is proven separately by isolation-smoke.sh.
#
# Usage:
#   WORKER_URL=https://<worker>.workers.dev \
#   SERVICE_AUTH_SECRET=<secret> \
#   ./scripts/functional-smoke.sh
set -euo pipefail
: "${WORKER_URL:?set WORKER_URL}"
: "${SERVICE_AUTH_SECRET:?set SERVICE_AUTH_SECRET}"

A="agent-$(printf '%08x' "$RANDOM")aaaa"
B="agent-$(printf '%08x' "$RANDOM")bbbb"
AUTH="Authorization: Bearer ${SERVICE_AUTH_SECRET}"
fail=0

req() { curl -sS -X "$1" "$WORKER_URL$3" -H "$AUTH" -H "X-Divinci-Agent-Id: $2" ${4:+-H "Content-Type: application/json" -d "$4"}; }

echo "== 1. Non-root boot check (both agents) =="
for id in "$A" "$B"; do
  r=$(req GET "$id" /hosted/agent/boot-check)
  echo "  $id: $r"
  echo "$r" | grep -q '"nonRoot":true' || { echo "  ✗ $id gateway is NOT running as non-root"; fail=1; }
done

echo "== 2. Real chat completion (both agents) =="
BODY='{"model":"anthropic/claude-sonnet-4-5","messages":[{"role":"user","content":"Reply with exactly: PONG"}],"stream":false}'
for id in "$A" "$B"; do
  code=$(curl -sS -o /tmp/hw-chat-$id.json -w '%{http_code}' -X POST "$WORKER_URL/hosted/agent/v1/chat/completions" \
    -H "$AUTH" -H "X-Divinci-Agent-Id: $id" -H "Content-Type: application/json" -d "$BODY")
  body=$(cat /tmp/hw-chat-$id.json 2>/dev/null | head -c 400)
  echo "  $id -> HTTP $code"
  [ "$code" = "200" ] || { echo "  ✗ $id chat returned $code: $body"; fail=1; }
  echo "$body" | grep -qiE 'choices|content|pong' || { echo "  ✗ $id chat body unexpected: $body"; fail=1; }
  rm -f /tmp/hw-chat-$id.json
done

if [ "$fail" = 0 ]; then
  echo "✅ FUNCTIONAL PROVEN: both agents boot Hermes as non-root and answer chat completions."
else
  echo "❌ FUNCTIONAL CHECK FAILED."
  exit 1
fi
