#!/usr/bin/env bash
#
# boundary-test.sh — exercise the virtual-terminal security boundary and report
# PASS/FAIL per property. Run inside the boundary-test image.
#
# This is the test that matters most for this feature: every claim the terminal
# makes about containment is an OS-level claim, and OS-level claims are only
# believable when something has actually tried to break them.
#
# Exit 0 iff every property holds for the capability set the container was given.
set -uo pipefail

PASS=0; FAIL=0
ok()   { echo "  PASS  $*"; PASS=$((PASS+1)); }
bad()  { echo "  FAIL  $*"; FAIL=$((FAIL+1)); }
hdr()  { echo; echo "== $* =="; }

TERM_USER=hermes-term
as_term() { gosu "$TERM_USER" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin "$@"; }

hdr "Capability probe"
if capsh --print 2>/dev/null | grep -q 'cap_net_admin'; then
  HAVE_NET_ADMIN=1; echo "  NET_ADMIN: GRANTED"
elif iptables -w 5 -L -n >/dev/null 2>&1; then
  HAVE_NET_ADMIN=1; echo "  NET_ADMIN: usable (iptables works)"
else
  HAVE_NET_ADMIN=0; echo "  NET_ADMIN: NOT AVAILABLE"
fi

hdr "Boundary setup (setup-terminal.sh)"
if /usr/local/bin/setup-terminal.sh; then
  SETUP_RC=0; echo "  setup exit: 0"
else
  SETUP_RC=$?; echo "  setup exit: $SETUP_RC"
fi

if [ "$HAVE_NET_ADMIN" -eq 0 ]; then
  # The whole point of fail-closed: without the ability to enforce egress, the
  # terminal must NOT come up. A degraded terminal is a different product.
  hdr "Fail-closed behaviour (no NET_ADMIN)"
  if [ "$SETUP_RC" -ne 0 ]; then
    ok "setup refused to establish a boundary it cannot enforce"
  else
    bad "setup returned 0 without NET_ADMIN — terminal would run UNCONTAINED"
  fi
  echo; echo "RESULT: pass=$PASS fail=$FAIL"
  [ "$FAIL" -eq 0 ] && exit 0 || exit 1
fi

if [ "$SETUP_RC" -ne 0 ]; then
  bad "setup failed despite NET_ADMIN being available"
  echo; echo "RESULT: pass=$PASS fail=$FAIL"; exit 1
fi
ok "boundary established"

hdr "1. Identity — terminal user cannot reach provider credentials"
uid=$(as_term id -u)
[ "$uid" = "10002" ] && ok "runs as uid 10002 (not root, not the credential owner)" \
                     || bad "unexpected uid: $uid"
if as_term cat /home/hermes/.hermes/.env >/dev/null 2>&1; then
  bad "terminal user READ the credential file"
else
  ok "credential file unreadable (~hermes/.hermes/.env)"
fi
if as_term ls /home/hermes/.hermes >/dev/null 2>&1; then
  bad "terminal user can LIST the credential directory"
else
  ok "credential directory unlistable"
fi
# The sentinel must not surface through any path the terminal user can walk.
if as_term grep -r "FAKE-SENTINEL-VALUE" /home 2>/dev/null | grep -q .; then
  bad "sentinel credential value was reachable from the terminal user"
else
  ok "sentinel credential value not reachable"
fi

hdr "2. Environment — no inherited secrets"
envout=$(as_term env)
if echo "$envout" | grep -qE 'GEMINI_API_KEY|CLOUDFLARE_API_KEY|VERTEX_SA_JSON|HERMES_GATEWAY_TOKEN'; then
  bad "provider credentials present in the terminal environment"
else
  ok "environment carries no provider credentials"
fi

hdr "3. Network — egress is allowlisted and unbypassable"
# Direct connection, explicitly ignoring the proxy: must be blocked at the
# packet layer. This is the property the proxy alone cannot provide.
if as_term curl -s --max-time 6 --noproxy '*' -o /dev/null https://example.com 2>/dev/null; then
  bad "direct egress to a NON-allowlisted host succeeded (proxy is bypassable)"
else
  ok "direct egress to a non-allowlisted host blocked"
fi
if as_term curl -s --max-time 6 --noproxy '*' -o /dev/null https://github.com 2>/dev/null; then
  bad "direct egress to an allowlisted host bypassed the guard"
else
  ok "even allowlisted hosts must transit the guard"
fi
# Through the guard: allowlisted host should work, non-allowlisted must be
# refused. NOTE curl reports %{http_code}=000 for a REFUSED CONNECT tunnel — it
# does not surface the proxy's 403 status — so asserting on http_code here gives
# a false failure. The honest signals are curl's exit code (56 = aborted by the
# proxy) and the guard's own audit log, which is the ground truth for what the
# guard actually decided.
AUDIT=/var/log/hermes-egress.log
try_via_guard() { as_term curl -s --max-time 15 -o /dev/null --proxy http://127.0.0.1:3128 "$1" >/dev/null 2>&1; echo $?; }
audit_says() { grep -F "\"decision\":\"$1\"" "$AUDIT" 2>/dev/null | grep -Fq "\"host\":\"$2\""; }

rc=$(try_via_guard https://github.com)
[ "$rc" = "0" ] && ok "allowlisted host reachable through the guard" \
                || bad "allowlisted host NOT reachable through the guard (curl exit $rc)"
audit_says allow github.com && ok "guard logged ALLOW for github.com" \
                            || bad "guard did not log an allow for github.com"

rc=$(try_via_guard https://example.com)
[ "$rc" != "0" ] && ok "non-allowlisted host refused by the guard (curl exit $rc)" \
                 || bad "guard ALLOWED a non-allowlisted host"
audit_says deny example.com && ok "guard logged DENY for example.com" \
                            || bad "guard did not log a deny for example.com"

# Dot-anchored matching: a lookalike must NOT be treated as a subdomain.
# A naive endsWith("github.com") would admit this.
rc=$(try_via_guard https://github.com.example.com)
[ "$rc" != "0" ] && ok "lookalike domain refused (curl exit $rc)" \
                 || bad "lookalike domain ALLOWED — suffix matching is unsafe"
audit_says deny github.com.example.com && ok "guard logged DENY for the lookalike domain" \
                                       || bad "guard did not log a deny for the lookalike"

hdr "4. Filesystem — workspace ownership"
as_term touch /workspace/probe 2>/dev/null && ok "workspace writable by the terminal user" \
                                           || bad "workspace not writable"
as_term touch /etc/probe 2>/dev/null && bad "terminal user wrote to /etc" \
                                     || ok "/etc not writable"

echo; echo "RESULT: pass=$PASS fail=$FAIL"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
