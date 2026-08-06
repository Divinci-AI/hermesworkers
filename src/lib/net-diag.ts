/**
 * Network-boundary diagnostic for the hosted terminal.
 *
 * WHY THIS EXISTS: `setup-terminal.sh` fails its egress self-test in the hosted
 * sandbox — the terminal user reaches the open internet even though the
 * iptables owner-match rules install successfully. The terminal is the only
 * arbitrary-exec surface, and it is gated behind the very boundary that is
 * failing, so there was no way to look. A container change costs a ~30 min
 * eviction to take effect; this is a Worker-only surface that runs a FIXED
 * battery through the same root `container.exec` that boot-check uses, so the
 * debug loop is seconds instead of half an hour.
 *
 * The command string is a constant. Nothing here interpolates caller input —
 * this must never become a general exec endpoint, which is what the terminal
 * routes are (and why they are gated).
 */

/**
 * Fixed probe battery. Ordered so the decisive facts come first:
 *
 *  - `iptables -L … -v` packet COUNTERS are the whole question. The rules
 *    demonstrably install; if their counters are zero after a connection
 *    attempt then the packets never traverse the chain, and no amount of
 *    rule-writing will help — the enforcement point is wrong, not the rule.
 *  - the self-test is re-run here so the counters are read immediately after a
 *    known attempt, rather than against whatever happened to occur since boot.
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
  // now installs the mirrored ip6tables chain; these probes confirm it is
  // present and matching.
  "echo '=== ip6tables available? ==='",
  "command -v ip6tables && ip6tables -V 2>&1 || echo '(ip6tables MISSING)'",
  "echo '=== ip6 OUTPUT + HERMES_TERM6 (counters tell you if it is matching) ==='",
  "ip6tables -L OUTPUT -n -v --line-numbers 2>&1 | head -10",
  "ip6tables -L HERMES_TERM6 -n -v --line-numbers 2>&1 | head -10",

  "echo '=== per-family egress probe (http=000 + nonzero exit == blocked) ==='",
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -4 -s --max-time 8 --noproxy '*' -o /dev/null -w 'v4 http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1; echo \"v4 curl_exit=$?\"",
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -6 -s --max-time 8 --noproxy '*' -o /dev/null -w 'v6 http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1; echo \"v6 curl_exit=$?\"",
  "gosu hermes-term env -i PATH=/usr/bin:/bin curl -s --max-time 8 --noproxy '*' -o /dev/null -w 'default http=%{http_code} ip=%{remote_ip}\\n' https://example.com 2>&1; echo \"default curl_exit=$?\"",
].join('; ');
