#!/usr/bin/env bash
# Live multi-tenant isolation proof against a DEPLOYED hosted Worker.
#
# Proves two agents never share a container: each writes its own marker, then we
# assert neither agent can read the other's marker.
#
# Usage:
#   WORKER_URL=https://<worker>.workers.dev \
#   SERVICE_AUTH_SECRET=<the secret you set> \
#   ./scripts/isolation-smoke.sh
#
# Exits non-zero if isolation is violated.

set -euo pipefail

: "${WORKER_URL:?set WORKER_URL}"
: "${SERVICE_AUTH_SECRET:?set SERVICE_AUTH_SECRET}"

A="agent-$(printf '%08x' "$RANDOM")aaaa"
B="agent-$(printf '%08x' "$RANDOM")bbbb"
AUTH="Authorization: Bearer ${SERVICE_AUTH_SECRET}"

echo "Agent A = $A"
echo "Agent B = $B"

req() { # method agentId path
  curl -sS -X "$1" "$WORKER_URL$3" -H "$AUTH" -H "X-Divinci-Agent-Id: $2"
}

echo "== 1. Each agent writes its own marker =="
A_WROTE=$(req POST "$A" /hosted/agent/probe); echo "  A: $A_WROTE"
B_WROTE=$(req POST "$B" /hosted/agent/probe); echo "  B: $B_WROTE"

echo "== 2. Read back — each must see ONLY its own marker =="
A_READ=$(req GET "$A" /hosted/agent/probe); echo "  A reads: $A_READ"
B_READ=$(req GET "$B" /hosted/agent/probe); echo "  B reads: $B_READ"

# Extract the "read" field (grep avoids a jq dependency).
a_val=$(printf '%s' "$A_READ" | grep -o '"read":"[^"]*"' | cut -d'"' -f4)
b_val=$(printf '%s' "$B_READ" | grep -o '"read":"[^"]*"' | cut -d'"' -f4)

echo "== 3. Assertions =="
fail=0
[ "$a_val" = "marker-for-$A" ] || { echo "  ✗ A saw '$a_val', expected marker-for-$A"; fail=1; }
[ "$b_val" = "marker-for-$B" ] || { echo "  ✗ B saw '$b_val', expected marker-for-$B"; fail=1; }
[ "$a_val" != "marker-for-$B" ] || { echo "  ✗ ISOLATION BREACH: A saw B's marker"; fail=1; }
[ "$b_val" != "marker-for-$A" ] || { echo "  ✗ ISOLATION BREACH: B saw A's marker"; fail=1; }

echo "== 4. Auth negative checks =="
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$WORKER_URL/hosted/agent/probe" \
  -H "Authorization: Bearer wrong-secret" -H "X-Divinci-Agent-Id: $A")
[ "$code" = "401" ] || { echo "  ✗ wrong service token returned $code, expected 401"; fail=1; }
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$WORKER_URL/hosted/agent/probe" \
  -H "$AUTH" -H "X-Divinci-Agent-Id: ../evil")
[ "$code" = "400" ] || { echo "  ✗ invalid agentId returned $code, expected 400"; fail=1; }

if [ "$fail" = 0 ]; then
  echo "✅ ISOLATION PROVEN: two agents, two containers, no cross-talk; auth rejects bad token + bad id."
else
  echo "❌ ISOLATION CHECK FAILED — do not proceed to GA."
  exit 1
fi
