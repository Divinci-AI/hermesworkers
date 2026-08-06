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
#   3. NETWORK — iptables AND ip6tables owner-match REJECT all egress from uid
#      10002 except loopback (to the egress guard) and DNS. Everything else must
#      transit the allowlisting proxy. Without this layer the proxy is advisory:
#      any command could simply ignore HTTP_PROXY and open a socket.
#
#      BOTH families are mandatory. The sandbox is dual-stack, so an IPv4-only
#      ruleset leaves egress fully open over IPv6 — which is what shipped, and
#      what a default `curl` actually used. See §3b.
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
# The FATAL goes to BOTH streams. It used to be stderr-only, and the caller
# (ensureTerminalBoundary) reports `stderr || stdout` — when the exec surfaced
# no stderr, the reason the boundary failed was silently dropped and the error
# read as "exits 1 after the last successful step" with no cause. Duplicating
# onto stdout costs nothing and is the difference between a diagnosable refusal
# and a mystery.
fail() {
  echo "[setup-terminal] FATAL: $*"
  echo "[setup-terminal] FATAL: $*" >&2
  exit 1
}

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

# ── 3b. The SAME lockdown for IPv6 ─────────────────────────────────────────
# `iptables` governs IPv4 only. The sandbox is dual-stack — cfeth0 carries a
# global IPv6 address — so an IPv4-only ruleset leaves egress wide open over
# IPv6, and curl's happy-eyeballs prefers it. That is not a corner case: it is
# the path a default `curl https://…` actually takes, which is why the v4 rules
# showed correct REJECT counters while the self-test still reached the internet.
#
# Without ip6tables there is no way to close that half, so this is fail-closed
# for the same reason the v4 side is: a boundary that only covers one address
# family is not a boundary.
command -v ip6tables >/dev/null 2>&1 || fail "ip6tables not available; cannot lock down IPv6 egress"

# NOTE the deliberate asymmetry with the IPv4 block above: no custom chain here,
# the rules go straight into OUTPUT.
#
# A custom v6 chain DOES work on a clean container — but this `ip6tables` is the
# nft-backed build, and a HERMES_TERM6 chain was observed reaching a state the
# iptables-nft compatibility layer could no longer map:
#
#   ip6tables: chain `HERMES_TERM6' in table `filter' is incompatible, use 'nft' tool.
#
# In that state the chain cannot be listed, flushed or deleted through
# ip6tables, `nft` is not installed in this image, and IPv6 egress silently
# reverts to open. Since that is reachable, and since a bricked boundary means a
# terminal that never comes up, the v6 side avoids the construct entirely.
# OUTPUT itself remained listable and writable throughout.
#
# The IPv4 chain is left as-is: it is long-established, has not exhibited this,
# and churning a working control adds risk rather than removing it.

# Idempotent cleanup. Repeat -D until it fails: an interrupted earlier run can
# leave duplicates, and a single -D removes only the first match.
for _ in 1 2 3 4 5; do
  ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$TERM_UID" -o lo -j ACCEPT 2>/dev/null || break
done
for _ in 1 2 3 4 5; do
  ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$TERM_UID" -p udp --dport 53 -j ACCEPT 2>/dev/null || break
done
for _ in 1 2 3 4 5; do
  ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$TERM_UID" -p tcp --dport 53 -j ACCEPT 2>/dev/null || break
done
for _ in 1 2 3 4 5; do
  ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$TERM_UID" -j REJECT --reject-with icmp6-port-unreachable 2>/dev/null || break
done
# Best-effort removal of a legacy custom chain from an earlier build. Failure is
# fine — the rules below do not depend on it, and it is unreferenced once the
# jump above is gone.
ip6tables -w 5 -D OUTPUT -m owner --uid-owner "$TERM_UID" -j HERMES_TERM6 2>/dev/null || true
ip6tables -w 5 -F HERMES_TERM6 2>/dev/null || true
ip6tables -w 5 -X HERMES_TERM6 2>/dev/null || true

ip6tables -w 5 -A OUTPUT -m owner --uid-owner "$TERM_UID" -o lo -j ACCEPT \
  || fail "cannot install IPv6 loopback rule; refusing to enable terminal"
ip6tables -w 5 -A OUTPUT -m owner --uid-owner "$TERM_UID" -p udp --dport 53 -j ACCEPT \
  || fail "cannot install IPv6 DNS rule; refusing to enable terminal"
ip6tables -w 5 -A OUTPUT -m owner --uid-owner "$TERM_UID" -p tcp --dport 53 -j ACCEPT \
  || fail "cannot install IPv6 DNS rule; refusing to enable terminal"
ip6tables -w 5 -A OUTPUT -m owner --uid-owner "$TERM_UID" -j REJECT --reject-with icmp6-port-unreachable \
  || fail "cannot install IPv6 reject rule; refusing to enable terminal"

log "network lockdown active for uid ${TERM_UID} on IPv4 AND IPv6 (loopback + DNS only; all else via guard)"

# ── 4. Self-test ───────────────────────────────────────────────────────────
# Prove the boundary holds before declaring success. A direct connection to a
# non-allowlisted host MUST fail for the terminal user.
#
# EACH ADDRESS FAMILY IS TESTED SEPARATELY, and this is the whole lesson of the
# 2026-08-06 failure: the old test issued a single default-stack curl, which
# happy-eyeballs is free to satisfy over EITHER family. It did catch the leak —
# but a default-stack probe can only ever tell you "at least one family is
# open", never which, and had v4 been the open one the same test could equally
# have passed while v6 leaked. Naming the family makes the failure actionable
# and makes a one-family regression impossible to miss.
#
# A family with no connectivity at all trivially "passes". That is the safe
# direction (nothing to block), and it is why the ip6tables rules above are
# installed unconditionally rather than only when v6 traffic is observed.
egress_blocked() { # $1 = curl family flag
  ! gosu "$TERM_USER" env -i PATH=/usr/bin:/bin \
      curl "$1" -s --max-time 5 --noproxy '*' -o /dev/null https://example.com 2>/dev/null
}

egress_blocked -4 || fail "self-test FAILED: terminal user reached the open internet over IPv4"
egress_blocked -6 || fail "self-test FAILED: terminal user reached the open internet over IPv6"
# Default stack last: with both families locked down this must also fail, and it
# catches anything that resolves through a path the explicit flags did not.
egress_blocked --http1.1 || fail "self-test FAILED: terminal user reached the open internet (default stack)"

log "self-test passed: direct egress from ${TERM_USER} is blocked on IPv4, IPv6 and the default stack"

log "terminal boundary established"
