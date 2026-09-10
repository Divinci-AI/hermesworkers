/**
 * The Divinci MCP bridge — how the agent gets web search and a guarded scrape.
 *
 * Hermes has no web_search and no web_fetch, and its bounded terminal is hard
 * blocked from the open web (iptables owner-match on uid 10002 + the egress
 * guard). So the agent cannot read a web page at all today. Rather than build a
 * second, weaker copy of the platform's SSRF guard, provider fallback and
 * escrow billing inside a container, this registers mcp.divinci.app, which has
 * all three.
 *
 * ⚠️ These tests EXECUTE the branch rather than reading it, for the reason the
 * Buffer tests give: every outage in this repo came from a shell block a text
 * assertion had "covered". The section is extracted and run against a stub
 * `hermes`, and the assertions are about what it CALLED.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const script = readFileSync(join(repoRoot, "container/start-hermes.sh"), "utf8");

/** The Divinci section, verbatim, between its banner and the next comment block. */
function divinciSection(): string {
  const start = script.indexOf("# ── Divinci MCP");
  const end = script.indexOf("# Optional defense in depth", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

interface Run { calls: string[]; log: string; envFile: string | null; envMode: number | null }

function run(env: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "divinci-mcp-"));
  const calls = join(dir, "calls.txt");
  const bin = join(dir, "hermes");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${calls}\n`);
  chmodSync(bin, 0o755);
  const logFile = join(dir, "hermes.log");
  const envFile = join(dir, "hermes.env");
  writeFileSync(logFile, "");
  const body = [
    "set -u",
    `PATH=${dir}:$PATH`,
    `LOG_FILE=${logFile}`,
    `HERMES_ENV_FILE=${envFile}`,
    divinciSection(),
  ].join("\n");
  execFileSync("bash", ["-c", body], { env: { ...process.env, ...env } });
  return {
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
    log: readFileSync(logFile, "utf8"),
    envFile: existsSync(envFile) ? readFileSync(envFile, "utf8") : null,
    envMode: existsSync(envFile) ? statSync(envFile).mode & 0o777 : null,
  };
}

const ON = { HERMES_DIVINCI_MCP_ENABLED: "true" };

describe("divinci MCP registration", () => {
  it("registers nothing when the feature is off", () => {
    const r = run({
      HERMES_DIVINCI_MCP_ENABLED: "false",
      DIVINCI_WHITELABEL_ID: "wl1",
      DIVINCI_API_KEY: "dk_abc",
    });
    expect(r.calls).toEqual([]);
    expect(r.log).toContain("HERMES_DIVINCI_MCP_ENABLED!=true");
  });

  describe("refusing to register a loop", () => {
    it("does NOT register when enabled with no key", () => {
      // Same failure as Buffer: the whitelabel endpoint answers an
      // unauthenticated connect with 401 unless a release opted into anonymous
      // access, the client retries and parks, and a missing secret never
      // changes on its own. The gateway log is the only window into a hosted
      // container, so this is not cosmetic.
      const r = run({ ...ON, DIVINCI_WHITELABEL_ID: "wl1", DIVINCI_API_KEY: "" });
      expect(r.calls.filter((c) => c.includes("mcp_servers.divinci"))).toEqual([]);
      expect(r.log).toContain("DIVINCI_API_KEY is unset");
      expect(r.log).toMatch(/retry loop|floods/i);
    });

    it("does NOT register without a whitelabel, and says there is no default", () => {
      // The endpoint is per-tenant (/{whitelabelId}/mcp). Guessing one would
      // point the container at somebody else's tool surface.
      const r = run({ ...ON, DIVINCI_API_KEY: "dk_abc" });
      expect(r.calls.filter((c) => c.includes("mcp_servers.divinci"))).toEqual([]);
      expect(r.log).toContain("DIVINCI_WHITELABEL_ID");
      expect(r.log).toMatch(/no default/i);
    });

    it("skips rather than registering half-configured, so it is self-correcting", () => {
      // Seed the secret and the next boot registers normally. Flipping the
      // feature flag off instead would need a second, opposite edit later and
      // the intent would be lost.
      const before = run({ ...ON, DIVINCI_WHITELABEL_ID: "wl1", DIVINCI_API_KEY: "" });
      const after = run({ ...ON, DIVINCI_WHITELABEL_ID: "wl1", DIVINCI_API_KEY: "dk_abc" });
      expect(before.calls).toEqual([]);
      expect(after.calls.length).toBeGreaterThan(0);
    });
  });

  describe("a complete configuration", () => {
    const full = { ...ON, DIVINCI_WHITELABEL_ID: "wl1", DIVINCI_API_KEY: "dk_abc" };

    it("registers the per-whitelabel endpoint", () => {
      const r = run(full);
      expect(r.calls.some((c) =>
        c.includes("mcp_servers.divinci.url https://mcp.divinci.app/wl1/mcp"))).toBe(true);
      expect(r.calls.some((c) => c.includes("mcp_servers.divinci.enabled true"))).toBe(true);
      expect(r.log).toContain("token=set");
    });

    it("keeps the key out of config.yaml and off the argv, in the 0600 env file", () => {
      // argv is world-readable via `ps`, and `config set` would also write the
      // value into config.yaml as plaintext. The literal ${env:…} form is
      // resolved by Hermes at connect time.
      const r = run(full);
      expect(r.calls.join("\n")).not.toContain("dk_abc");
      expect(r.calls.join("\n")).toContain("${env:DIVINCI_API_KEY}");
      expect(r.envFile).toContain("DIVINCI_API_KEY=dk_abc");
      expect(r.envMode).toBe(0o600);
    });

    it("does not accumulate duplicate keys across reboots", () => {
      // The env file survives; appending blindly would leave two DIVINCI_API_KEY
      // lines and the loser is whichever the parser happens to prefer.
      const dir = mkdtempSync(join(tmpdir(), "divinci-mcp-dup-"));
      const envFile = join(dir, "hermes.env");
      writeFileSync(envFile, "DIVINCI_API_KEY=stale\nOTHER=keep\n");
      const bin = join(dir, "hermes");
      writeFileSync(bin, "#!/bin/sh\nexit 0\n");
      chmodSync(bin, 0o755);
      const logFile = join(dir, "hermes.log");
      writeFileSync(logFile, "");
      execFileSync("bash", ["-c", [
        "set -u", `PATH=${dir}:$PATH`, `LOG_FILE=${logFile}`,
        `HERMES_ENV_FILE=${envFile}`, divinciSection(),
      ].join("\n")], { env: { ...process.env, ...full } });

      const contents = readFileSync(envFile, "utf8");
      expect(contents.match(/^DIVINCI_API_KEY=/gm)).toHaveLength(1);
      expect(contents).toContain("DIVINCI_API_KEY=dk_abc");
      expect(contents).toContain("OTHER=keep");
    });

    it("lets an explicit URL win over the whitelabel id", () => {
      const r = run({ ...full, DIVINCI_MCP_URL: "https://mcp.stage.divinci.app/wl9/mcp" });
      expect(r.calls.some((c) =>
        c.includes("mcp_servers.divinci.url https://mcp.stage.divinci.app/wl9/mcp"))).toBe(true);
    });

    it("gives the connect longer than Buffer's 30s", () => {
      // The endpoint resolves the whitelabel's MCP config and computes the tool
      // surface across every enabled release before it answers, and public-api
      // cold-starts. 30s upstream timeouts are what wedged Canva on 2026-08-24.
      const r = run(full);
      expect(r.calls.some((c) => c.includes("mcp_servers.divinci.connect_timeout 60"))).toBe(true);
    });
  });
});

describe("the config actually REACHES the container", () => {
  // Worker [vars] and secrets are not in the container process; they are
  // forwarded explicitly. A flag set in wrangler.toml but never forwarded reads
  // as unset in start-hermes.sh, and the feature silently does not happen —
  // which is exactly how HERMES_DISABLED_TOOLSETS shipped and did nothing, and
  // how EGRESS_ALLOWED_HOSTS was left inert.
  //
  // ⚠️ container-env-forwarding.test.ts does NOT cover these. It scans only
  // `HERMES_*` names, and two of the three here are DIVINCI_*. That blind spot
  // is the one that missed EGRESS_ALLOWED_HOSTS, so these are asserted by hand
  // rather than assumed covered.
  const src = readFileSync(join(repoRoot, "src/lib/container.ts"), "utf8");

  it.each([
    "HERMES_DIVINCI_MCP_ENABLED",
    "DIVINCI_WHITELABEL_ID",
    "DIVINCI_MCP_URL",
    "DIVINCI_API_KEY",
  ])("forwards %s", (name) => {
    expect(src).toMatch(new RegExp(`keys\\.${name}\\s*=`));
  });

  it("forwards them only when the feature is enabled", () => {
    // The secret should not travel to the container for a deployment that has
    // not opted in.
    const guard = src.indexOf('env.HERMES_DIVINCI_MCP_ENABLED === "true"');
    const assign = src.indexOf("keys.DIVINCI_API_KEY =");
    expect(guard).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(guard);
    // …and inside that block, not merely after it.
    expect(src.slice(guard, assign)).not.toContain("\n  }\n");
  });
});

describe("the Divinci MCP is off by default", () => {
  it("is not enabled in any deployed config", () => {
    // Enabling it against a release that has NOT curated mcpConfig.exposedTools
    // hands the container the whole catalog — spend-marked tools,
    // release_update, hermes_create, hermes_proactive_set. That allowlist is
    // the entire boundary: checkToolRateLimit has no callers and TOOL_RISK
    // enforces nothing. Turning this on is a deliberate act per deployment,
    // after curating the release.
    for (const f of ["wrangler.toml", "wrangler.staging.toml", "wrangler.production.toml"]) {
      const path = join(repoRoot, f);
      if (!existsSync(path)) continue;
      const src = readFileSync(path, "utf8");
      const line = src.split("\n").find((l) => l.startsWith("HERMES_DIVINCI_MCP_ENABLED"));
      expect(line ?? 'HERMES_DIVINCI_MCP_ENABLED = "false"').not.toContain('"true"');
    }
  });
});
