#!/usr/bin/env bash
#
# setup-terminal.sh — establish the Hermes virtual-terminal security boundary.
#
# Run ONCE at container boot, as root, BEFORE any terminal command is accepted.
# It either establishes the full boundary and exits 0, or exits non-zero — and
# the Worker refuses to enable the terminal for that container. There is no
# degraded mode: a terminal without egress control is a different (and much
# worse) product than the one we shipped, so it must never come up by accident.
#
# THE BOUNDARY, in layers:
#
#   1. IDENTITY — terminal commands run as `hermes-term` (uid 10002), NOT as
#      root and NOT as `hermes` (uid 10001). `~hermes/.hermes/` holds the
#      provider credentials (Vertex SA JSON, Cloudflare API key, customer BYOK
#      keys) at 0700 owned by `hermes`, so the terminal user cannot read them
#      even though they sit in the same container. This is the control that
#      matters most: once the agent can run arbitrary commands, `env` and
#      `cat ~/.hermes/.env` are the first things a prompt injection reaches for.
#
#   2. ENVIRONMENT — commands are launched with `env -i` plus a small explicit
#      allowlist. The Sandbox SDK's per-exec `env` option can only OVERRIDE
#      variables, never unset them, so relying on it to hide credentials would
#      leave them readable. Starting from an empty environment is the only way
#      to be sure.
#
#   3. NETWORK — iptables owner-match REJECTs all egress from uid 10002 except
#      loopback (to the egress guard) and DNS. Everything else must transit the
#      allowlisting proxy. Without this layer the proxy is advisory: any command
#      could simply ignore HTTP_PROXY and open a socket.
#
#   4. FILESYSTEM — /workspace is owned by hermes-term; the Worker confines all
#      file tool paths to it. Layer 1 is what stops a shell command from
#      wandering outside it.
#
set -euo pipefail

TERM_UID=10002
TERM_USER=hermes-term
WORKSPACE=/workspace
PROXY_PORT="${EGRESS_PROXY_PORT:-3128}"
GUARD=/usr/local/bin/egress-guard.js
GUARD_LOG=/var/log/hermes-egress-guard.out

log() { echo "[setup-terminal] $*"; }
fail() { echo "[setup-terminal] FATAL: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "must run as root to establish the terminal boundary"

# ── 1. Workspace ───────────────────────────────────────────────────────────
mkdir -p "$WORKSPACE"
chown "${TERM_UID}:${TERM_UID}" "$WORKSPACE"
chmod 0750 "$WORKSPACE"
log "workspace ${WORKSPACE} owned by ${TERM_USER}"

# Re-assert that the Hermes credential directory is unreadable by the terminal
# user. The Dockerfile sets this up, but boot-time enforcement means a future
# image change can't silently widen it.
if [ -d /home/hermes/.hermes ]; then
  chmod 0700 /home/hermes/.hermes || true
  chown -R hermes:hermes /home/hermes/.hermes || true
fi
chmod 0711 /home/hermes || true
if gosu "$TERM_USER" test -r /home/hermes/.hermes/.env 2>/dev/null; then
  fail "terminal user can read /home/hermes/.hermes/.env — credential isolation is broken"
fi
log "credential isolation verified (${TERM_USER} cannot read ~hermes/.hermes/.env)"

# ── 2. Egress guard ────────────────────────────────────────────────────────
[ -f "$GUARD" ] || fail "egress guard not found at ${GUARD}"

if [ -z "${EGRESS_ALLOWED_HOSTS:-}" ]; then
  # Empty allowlist is a valid (deny-all) posture, but it is almost always a
  # misconfiguration, so say so loudly rather than silently breaking clones.
  log "WARNING: EGRESS_ALLOWED_HOSTS is empty — all terminal egress will be denied"
fi

# Start the guard as the `hermes` user: it must NOT be reachable-as-root, and it
# must not run as hermes-term (which would let terminal commands kill it).
nohup gosu hermes env \
  EGRESS_PROXY_PORT="$PROXY_PORT" \
  EGRESS_ALLOWED_HOSTS="${EGRESS_ALLOWED_HOSTS:-}" \
  EGRESS_AUDIT_LOG=/var/log/hermes-egress.log \
  node "$GUARD" >"$GUARD_LOG" 2>&1 &

# Wait for it to actually listen. A boundary that isn't up yet is no boundary.
for _ in $(seq 1 50); do
  if (exec 3<>/dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null; then
    exec 3<&- 2>/dev/null || true
    break
  fi
  sleep 0.2
done
(exec 3<>/dev/tcp/127.0.0.1/"$PROXY_PORT") 2>/dev/null || {
  log "guard log follows:"; cat "$GUARD_LOG" >&2 || true
  fail "egress guard failed to listen on 127.0.0.1:${PROXY_PORT}"
}
exec 3<&- 2>/dev/null || true
log "egress guard listening on 127.0.0.1:${PROXY_PORT}"

# ── 3. Network lockdown ────────────────────────────────────────────────────
# Without this, the proxy is advisory. If we cannot install these rules we do
# NOT come up — see the fail-closed note in the header.
command -v iptables >/dev/null 2>&1 || fail "iptables not available; cannot lock down terminal egress"

# Idempotent: flush any prior HERMES_TERM chain before rebuilding.
iptables -w 5 -D OUTPUT -m owner --uid-owner "$TERM_UID" -j HERMES_TERM 2>/dev/null || true
iptables -w 5 -F HERMES_TERM 2>/dev/null || true
iptables -w 5 -X HERMES_TERM 2>/dev/null || true

if ! iptables -w 5 -N HERMES_TERM 2>/dev/null; then
  fail "cannot create iptables chain (NET_ADMIN unavailable?); refusing to enable terminal"
fi

# Loopback — reaches the egress guard (and nothing else useful).
iptables -w 5 -A HERMES_TERM -o lo -j ACCEPT
# DNS, so hostnames resolve before the guard re-checks them against the
# allowlist. Resolution is not exfiltration-proof (DNS tunnelling exists), but
# the guard controls where bytes can actually go.
iptables -w 5 -A HERMES_TERM -p udp --dport 53 -j ACCEPT
iptables -w 5 -A HERMES_TERM -p tcp --dport 53 -j ACCEPT
# Everything else from this uid: rejected, with a fast error rather than a hang
# so a blocked command fails in milliseconds and the agent gets a clear message.
iptables -w 5 -A HERMES_TERM -j REJECT --reject-with icmp-port-unreachable

iptables -w 5 -A OUTPUT -m owner --uid-owner "$TERM_UID" -j HERMES_TERM \
  || fail "cannot attach owner-match rule; refusing to enable terminal"

log "network lockdown active for uid ${TERM_UID} (loopback + DNS only; all else via guard)"

# ── 4. Self-test ───────────────────────────────────────────────────────────
# Prove the boundary holds before declaring success. A direct connection to a
# non-allowlisted host MUST fail for the terminal user.
if gosu "$TERM_USER" env -i PATH=/usr/bin:/bin \
     curl -s --max-time 5 --noproxy '*' -o /dev/null https://example.com 2>/dev/null; then
  fail "self-test FAILED: terminal user reached the open internet directly"
fi
log "self-test passed: direct egress from ${TERM_USER} is blocked"

log "terminal boundary established"
