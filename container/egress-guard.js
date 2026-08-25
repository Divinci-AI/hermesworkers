#!/usr/bin/env node
/**
 * Egress guard — an allowlisting HTTP/HTTPS forward proxy for the terminal user.
 *
 * WHY THIS EXISTS
 * The Hermes virtual terminal can clone repositories and run arbitrary build
 * commands. Two things follow from that:
 *   1. The contents of a cloned repo are UNTRUSTED INPUT to the model. A README
 *      or a test fixture can carry a prompt injection.
 *   2. A container with unrestricted outbound network is an exfiltration path.
 * So the terminal user must not be able to reach arbitrary hosts. This process
 * is the only route out: `setup-terminal.sh` installs iptables owner-match rules
 * that REJECT all egress from the terminal uid except loopback to this port and
 * DNS, so bypassing the proxy (curl --noproxy, a raw socket, a vendored
 * downloader that ignores HTTP_PROXY) fails at the packet layer rather than
 * silently succeeding.
 *
 * The proxy is deliberately dependency-free (Node's stdlib only, Node 22 is
 * already in the image) so it adds no supply-chain surface to the thing whose
 * entire job is containing supply-chain surface.
 *
 * FAIL-CLOSED: an unparseable or empty allowlist denies everything rather than
 * defaulting to allow. A guard that fails open is not a guard.
 */
"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");

const PORT = Number(process.env.EGRESS_PROXY_PORT || "3128");
const BIND = "127.0.0.1";
const AUDIT_LOG = process.env.EGRESS_AUDIT_LOG || "/var/log/hermes-egress.log";

/**
 * Allowlist entries are matched as exact hostnames or as dot-anchored suffixes:
 * `github.com` matches `github.com` and `codeload.github.com`, but NOT
 * `evilgithub.com` or `github.com.attacker.net`. Anchoring on the dot is the
 * whole point — a naive `endsWith` is a bypass.
 *
 * An entry prefixed with `=` is EXACT-ONLY: `=divinci.ai` matches `divinci.ai`
 * and NOTHING under it.
 *
 * ⚠️ WHY EXACT-ONLY EXISTS. The suffix form is right for a vendor domain whose
 * every subdomain is equally public (github.com, npmjs.org). It is wrong for a
 * domain we own, where subdomains are separate systems at different trust
 * levels. `divinci.ai` as a SUFFIX would admit `fulcrum-acme.divinci.ai` — and
 * this container materializes a Fulcrum API token, which per that integration's
 * own note is code execution on the Fulcrum host. The terminal uid cannot read
 * that token today, but the allowlist is the SECOND barrier, and granting the
 * marketing site should not spend it. Reach for `=` whenever you are allowing a
 * host on a domain we control.
 */
function parseAllowlist(raw) {
  const exact = new Set();
  const suffix = [];
  for (const item of String(raw || "").split(",")) {
    let h = item.trim().toLowerCase();
    if (!h) continue;
    const exactOnly = h.startsWith("=");
    if (exactOnly) h = h.slice(1).trim();
    if (!h) continue;
    // Defensive: a wildcard entry would silently disable the guard.
    if (h === "*" || h.includes("*")) continue;
    if (exactOnly) exact.add(h.replace(/\.$/, ""));
    else suffix.push(h);
  }
  return { exact, suffix };
}

const ALLOWED = parseAllowlist(process.env.EGRESS_ALLOWED_HOSTS);
/** Flat view, for logging and the empty-allowlist check only. */
const ALLOWED_HOSTS = [...ALLOWED.exact].map((h) => `=${h}`).concat(ALLOWED.suffix);

/** Ports the guard will connect to at all. 443/80 only — no SSH, no SMTP. */
const ALLOWED_PORTS = new Set([80, 443]);

function isAllowedHost(hostname) {
  if (!hostname) return false;
  const h = hostname.toLowerCase().replace(/\.$/, ""); // strip FQDN trailing dot
  // An IP literal can never match a dot-anchored domain suffix, and allowing raw
  // IPs would let a caller skip DNS and reach anything. Reject explicitly.
  if (net.isIP(h)) return false;
  // Exact entries first: they never widen, so an `=` entry can only ever
  // ALLOW the one host it names.
  if (ALLOWED.exact.has(h)) return true;
  return ALLOWED.suffix.some((allowed) => h === allowed || h.endsWith(`.${allowed}`));
}

let auditStream = null;
function audit(decision, host, port, extra) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    decision,
    host: host || null,
    port: port || null,
    ...(extra || {}),
  });
  // Audit goes to stdout (captured in container logs) and, best-effort, to a
  // file the Worker can read back for support/abuse investigation.
  console.log(`[egress] ${line}`);
  try {
    if (!auditStream) {
      auditStream = fs.createWriteStream(AUDIT_LOG, { flags: "a" });
      // A stream error (EACCES on the log file, disk full) is emitted
      // ASYNCHRONOUSLY as an 'error' event — a try/catch around the write
      // cannot see it, and an unhandled 'error' event terminates the process.
      // That is exactly what happened the first time this was exercised in a
      // container: the guard died on the first request and every proxied
      // connection failed with "Proxy CONNECT aborted".
      //
      // The guard must survive its own logging failing. Audit is valuable but
      // it is NOT the security control — the iptables rules are — so degrade to
      // stdout-only rather than taking the whole boundary down with us.
      auditStream.on("error", (err) => {
        console.error(`[egress] audit log unavailable (${err.message}); continuing stdout-only`);
        auditStream = null;
      });
    }
    auditStream.write(`${line}\n`);
  } catch {
    // Never let audit failure break or block the request path.
  }
}

/** Split "host:port" — handles bracketed IPv6 literals. */
function splitHostPort(authority, defaultPort) {
  const v6 = /^\[(.+)\]:(\d+)$/.exec(authority);
  if (v6) return { host: v6[1], port: Number(v6[2]) };
  const idx = authority.lastIndexOf(":");
  if (idx === -1) return { host: authority, port: defaultPort };
  const maybePort = Number(authority.slice(idx + 1));
  if (!Number.isInteger(maybePort)) return { host: authority, port: defaultPort };
  return { host: authority.slice(0, idx), port: maybePort };
}

const server = http.createServer();

// ── Plain HTTP proxying ────────────────────────────────────────────────────
server.on("request", (req, res) => {
  let target;
  try {
    target = new URL(req.url);
  } catch {
    audit("deny", null, null, { reason: "unparseable-url" });
    res.writeHead(400).end("Bad proxy request");
    return;
  }
  const port = Number(target.port || 80);
  if (!isAllowedHost(target.hostname) || !ALLOWED_PORTS.has(port)) {
    audit("deny", target.hostname, port, { proto: "http" });
    res.writeHead(403, { "Content-Type": "text/plain" }).end(
      `Egress denied: ${target.hostname}:${port} is not on the Hermes terminal allowlist.\n`,
    );
    return;
  }
  audit("allow", target.hostname, port, { proto: "http" });

  const upstream = http.request(
    {
      host: target.hostname,
      port,
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end(`Upstream error: ${err.message}\n`);
  });
  req.pipe(upstream);
});

// ── HTTPS via CONNECT ──────────────────────────────────────────────────────
// Note we allow/deny on the CONNECT authority only. We do NOT terminate TLS, so
// this is not content inspection — it is destination control, which is the
// property we actually want (no MITM of the customer's traffic, no cert games).
server.on("connect", (req, clientSocket, head) => {
  const { host, port } = splitHostPort(req.url || "", 443);
  if (!isAllowedHost(host) || !ALLOWED_PORTS.has(port)) {
    audit("deny", host, port, { proto: "connect" });
    clientSocket.write(
      "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n" +
        `Egress denied: ${host}:${port} is not on the Hermes terminal allowlist.\n`,
    );
    clientSocket.destroy();
    return;
  }
  audit("allow", host, port, { proto: "connect" });

  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const bail = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", bail);
  clientSocket.on("error", bail);
});

server.on("clientError", (_err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

if (ALLOWED_HOSTS.length === 0) {
  // Still bind and run: with an empty allowlist every request is denied, which
  // is the correct fail-closed posture. Loud, so a misconfigured deploy is
  // obvious in the logs rather than mysteriously breaking every clone.
  console.error(
    "[egress] WARNING: EGRESS_ALLOWED_HOSTS is empty — ALL terminal egress will be denied.",
  );
}

// Only listen when run as a program. Requiring this file (tests) must not bind
// a port or leave a live handle behind.
if (require.main === module) server.listen(PORT, BIND, () => {
  console.log(
    `[egress] guard listening on ${BIND}:${PORT}; allowlist=${
      ALLOWED_HOSTS.length ? ALLOWED_HOSTS.join(",") : "(empty — deny all)"
    }`,
  );
});

module.exports = { parseAllowlist, isAllowedHost };
