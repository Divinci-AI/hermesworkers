/**
 * Registering the Buffer MCP without a key is a retry loop, not a degraded mode.
 *
 * `HERMES_BUFFER_MCP_ENABLED = "true"` has been set in wrangler.production.toml
 * with no `MCP_BUFFER_API_KEY` secret since the day it shipped. mcp.buffer.com
 * answers an unauthenticated connect with 401, the client retries 3x, parks,
 * and starts again on the next turn — forever, because nothing about a missing
 * secret changes on its own. Measured 2026-08-22: 960 of 999 gateway log lines
 * (96%) were Buffer retries. Still 28% on a freshly evicted container on
 * 2026-08-26, with the four lines repeating per turn.
 *
 * That is not cosmetic. `GET /hosted/agent/logs` is the ONLY window into a
 * hosted container, and it was being painted over by a feature that has never
 * once worked in production.
 *
 * ⚠️ These tests EXECUTE the branch rather than reading it. Every previous
 * outage in this repo came from a shell block that a text assertion had
 * "covered": `hermes config set model` was pinned by three static tests and
 * still destroyed the config mapping in production. So the section is extracted
 * and run against a stub `hermes`, and the assertions are about what it CALLED.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const script = readFileSync(join(repoRoot, "container/start-hermes.sh"), "utf8");

/** The Buffer section, verbatim, between its banner and the next one. */
function bufferSection(): string {
  const start = script.indexOf("# ── Buffer MCP");
  const end = script.indexOf("# ── Canva MCP", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return script.slice(start, end);
}

interface Run { calls: string[]; log: string; envFile: string | null; envMode: number | null }

function run(env: Record<string, string>): Run {
  const dir = mkdtempSync(join(tmpdir(), "buffer-mcp-"));
  const calls = join(dir, "calls.txt");
  // A stub `hermes` that records its argv. The real binary is not needed: what
  // is under test is whether this branch calls it at all.
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
    bufferSection(),
  ].join("\n");
  execFileSync("bash", ["-c", body], { env: { ...process.env, ...env } });
  return {
    calls: existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) : [],
    log: readFileSync(logFile, "utf8"),
    envFile: existsSync(envFile) ? readFileSync(envFile, "utf8") : null,
    envMode: existsSync(envFile) ? statSync(envFile).mode & 0o777 : null,
  };
}

describe("buffer MCP registration", () => {
  it("does NOT register when enabled with no key", () => {
    const r = run({ HERMES_BUFFER_MCP_ENABLED: "true", MCP_BUFFER_API_KEY: "" });
    expect(r.calls.filter((c) => c.includes("mcp_servers.buffer"))).toEqual([]);
    expect(r.log).toContain("MCP_BUFFER_API_KEY is unset");
  });

  it("says WHY in the log, so the fix is obvious from the only window we have", () => {
    const r = run({ HERMES_BUFFER_MCP_ENABLED: "true", MCP_BUFFER_API_KEY: "" });
    expect(r.log).toMatch(/retry loop|floods/i);
  });

  it("registers normally once a key is present — this is self-correcting", () => {
    const r = run({ HERMES_BUFFER_MCP_ENABLED: "true", MCP_BUFFER_API_KEY: "pat-abc" });
    const buffer = r.calls.filter((c) => c.includes("mcp_servers.buffer"));
    expect(buffer.some((c) => c.includes("mcp_servers.buffer.url"))).toBe(true);
    expect(buffer.some((c) => c.includes("mcp_servers.buffer.enabled true"))).toBe(true);
    expect(r.log).toContain("token=set");
  });

  it("keeps the key out of config.yaml and off the argv, in the 0600 env file", () => {
    // The header is written as the literal ${env:MCP_BUFFER_API_KEY}; Hermes
    // resolves it at connect time. A key passed to `config set` would land in a
    // loggable argv AND in config.yaml as plaintext.
    const r = run({ HERMES_BUFFER_MCP_ENABLED: "true", MCP_BUFFER_API_KEY: "pat-abc" });
    expect(r.calls.join("\n")).not.toContain("pat-abc");
    expect(r.envFile).toContain("MCP_BUFFER_API_KEY=pat-abc");
    expect(r.envMode).toBe(0o600);
  });

  it("registers nothing when the feature is off", () => {
    const r = run({ HERMES_BUFFER_MCP_ENABLED: "false", MCP_BUFFER_API_KEY: "pat-abc" });
    expect(r.calls).toEqual([]);
    expect(r.log).toContain("HERMES_BUFFER_MCP_ENABLED!=true");
  });
});
