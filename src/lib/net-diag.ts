/**
 * Network-boundary diagnostic for the hosted terminal.
 *
 * WHY THIS EXISTS: when the terminal's egress boundary is wrong, the terminal
 * itself — the only arbitrary-exec surface — is gated behind it, so there is no
 * way to look. This runs a FIXED battery through the same root `container.exec`
 * that boot-check uses. It also decouples the debug loop from the container:
 * a container change needs a ~30 min eviction to take effect, this is
 * Worker-only and lands in seconds.
 *
 * It found the 2026-08-06 failure: the lockdown covered IPv4 only on a
 * dual-stack sandbox, so a plain curl left over IPv6 while the v4 REJECT
 * counters ticked up and looked healthy.
 *
 * The command string is a constant. Nothing here interpolates caller input —
 * this must never become a general exec endpoint, which is what the terminal
 * routes are (and why they are gated).
 */

/**
 * Fixed probe battery. Ordered so the decisive facts come first:
 *
 *  - `iptables -L … -v` packet COUNTERS distinguish "the rule never sees the
 *    packet" (enforcement point is wrong) from "the rule sees it and the
 *    traffic left anyway by another path" — which is what actually happened.
 *  - egress is probed PER FAMILY. A default-stack probe can only ever report
 *    "at least one family is open", never which, so it cannot prove a
 *    dual-stack boundary. That ambiguity is exactly what hid the v6 hole.
 */
export const NET_DIAG_COMMAND = [
  "echo '=== whoami/uid ==='",
  'id',
  "id hermes-term 2>&1 || echo '(no hermes-term user)'",

  "echo '=== capabilities ==='",
  "capsh --print 2>/dev/null | grep -iE '^current|net_admin' || echo '(capsh unavailable)'",

  "echo '=== counters BEFORE attempt ==='",
  "iptables -L OUTPUT -n -v --line-numbers 2>&1 | head -20",
  "iptables -L HERMES_TERM -n -v --line-numbers 2>&1 | head -20",

  "echo '=== direct egress attempt as hermes-term ==='",
  // Mirrors the self-test in setup-terminal.sh exactly, but reports the outcome
  // instead of exiting on it.
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -s --max-time 8 --noproxy '*' -o /dev/null -w 'curl_exit_ok http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1 || echo \"curl_failed exit=$?\"",

  "echo '=== counters AFTER attempt ==='",
  "iptables -L OUTPUT -n -v --line-numbers 2>&1 | head -20",
  "iptables -L HERMES_TERM -n -v --line-numbers 2>&1 | head -20",

  "echo '=== does the owner module load at all ==='",
  "iptables -m owner --help 2>&1 | tail -5",

  "echo '=== routing / interfaces ==='",
  "ip -o addr 2>&1 | head -10",
  "ip route 2>&1 | head -10",
  "ip rule 2>&1 | head -10",

  "echo '=== nftables in play? ==='",
  "nft list ruleset 2>&1 | head -20 || echo '(nft unavailable)'",
  "iptables -V 2>&1",

  "echo '=== proxy env visible to terminal user ==='",
  "gosu hermes-term env 2>&1 | grep -iE 'proxy|http_' || echo '(none)'",

  "echo '=== guard listening ==='",
  "(ss -lntp 2>/dev/null || netstat -lntp 2>/dev/null) | head -15",

  // ── IPv6 ─────────────────────────────────────────────────────────────────
  // Read-only. The container is dual-stack and `iptables` governs IPv4 ONLY,
  // so this is where the boundary leaked: a default curl took the unfiltered
  // IPv6 path while the IPv4 attempt was correctly rejected. setup-terminal.sh
  // now installs the v6 rules too; these probes confirm they are present and
  // matching.
  "echo '=== ip6tables available? ==='",
  "command -v ip6tables && ip6tables -V 2>&1 || echo '(ip6tables MISSING)'",
  // The v6 rules live directly in OUTPUT (no custom chain — see setup-terminal.sh
  // §3b for why). Counters on the REJECT rule are what tell you it is matching.
  "echo '=== ip6 OUTPUT (counters tell you if it is matching) ==='",
  "ip6tables -L OUTPUT -n -v --line-numbers 2>&1 | head -15",
  "echo '=== legacy custom chain, if a poisoned one is still around ==='",
  "ip6tables -L HERMES_TERM6 -n -v 2>&1 | head -5 || true",

  "echo '=== per-family egress probe (http=000 + nonzero exit == blocked) ==='",
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -4 -s --max-time 8 --noproxy '*' -o /dev/null -w 'v4 http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1; echo \"v4 curl_exit=$?\"",
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -6 -s --max-time 8 --noproxy '*' -o /dev/null -w 'v6 http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1; echo \"v6 curl_exit=$?\"",
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -s --max-time 8 --noproxy '*' -o /dev/null -w 'default http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1; echo \"default curl_exit=$?\"",
].join('; ');
