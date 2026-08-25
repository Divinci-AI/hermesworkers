/**
 * The egress allowlist's `=host` EXACT-ONLY form.
 *
 * Suffix matching is right for a vendor domain whose every subdomain is equally
 * public (github.com, npmjs.org). It is wrong for a domain WE own, where
 * subdomains are separate systems at different trust levels: `divinci.ai` as a
 * suffix admits `fulcrum-acme.divinci.ai`, and this container materializes a
 * Fulcrum API token that is code execution on that host. The terminal uid cannot
 * read the token today — the allowlist is the SECOND barrier, and granting the
 * marketing site must not spend it.
 *
 * ⚠️ THE MODULE CANNOT BE REQUIRED FROM THE REPO. egress-guard.js uses CommonJS
 * `require`, and this repo's package.json is `"type": "module"`, so `node
 * container/egress-guard.js` dies with "require is not defined in ES module
 * scope". In the IMAGE it is copied to /usr/local/bin/, outside any
 * package.json, where it is CommonJS and correct. So the test copies it to a
 * package.json-free temp dir — reproducing the image's module resolution rather
 * than the repo's. Same class as the container config-contract test: the
 * artifact's semantics differ from the source tree's.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let guard: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "egress-guard-"));
  guard = join(dir, "egress-guard.js");
  copyFileSync(join(__dirname, "..", "container", "egress-guard.js"), guard);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Ask the guard, in a CommonJS context, whether it would allow a host. */
function allows(host: string, allowlist: string): boolean {
  const out = execFileSync(
    process.execPath,
    ["-e", `const g=require(${JSON.stringify(guard)});process.stdout.write(String(g.isAllowedHost(${JSON.stringify(host)})))`],
    { env: { ...process.env, EGRESS_ALLOWED_HOSTS: allowlist }, encoding: "utf8" },
  );
  return out.trim() === "true";
}

const LIST = "github.com,=divinci.ai,sdk.divinci.ai";

describe("`=host` is exact-only", () => {
  it("allows the exact host", () => {
    expect(allows("divinci.ai", LIST)).toBe(true);
  });

  it("REFUSES every subdomain of an exact entry", () => {
    // The reason this form exists. fulcrum-acme is the concrete one.
    expect(allows("fulcrum-acme.divinci.ai", LIST)).toBe(false);
    expect(allows("anything.divinci.ai", LIST)).toBe(false);
    expect(allows("a.b.divinci.ai", LIST)).toBe(false);
  });

  it("normalizes case and the FQDN trailing dot", () => {
    expect(allows("DIVINCI.AI", LIST)).toBe(true);
    expect(allows("divinci.ai.", LIST)).toBe(true);
  });
});

describe("suffix entries are unchanged", () => {
  it("still matches apex and subdomains", () => {
    expect(allows("github.com", LIST)).toBe(true);
    expect(allows("codeload.github.com", LIST)).toBe(true);
    expect(allows("sdk.divinci.ai", LIST)).toBe(true);
  });

  it("still anchors on the dot — no naive endsWith bypass", () => {
    expect(allows("evilgithub.com", LIST)).toBe(false);
    expect(allows("github.com.attacker.net", LIST)).toBe(false);
    expect(allows("divinci.ai.attacker.net", LIST)).toBe(false);
  });
});

describe("the guard still fails closed", () => {
  it("denies everything on an empty allowlist", () => {
    expect(allows("github.com", "")).toBe(false);
    expect(allows("divinci.ai", "")).toBe(false);
  });

  it("ignores wildcard entries rather than honouring them", () => {
    // A `*` entry would silently disable the guard.
    expect(allows("evil.com", "*")).toBe(false);
    expect(allows("evil.com", "=*")).toBe(false);
    expect(allows("evil.com", "*.com")).toBe(false);
  });

  it("drops a bare `=` instead of allowing the empty host", () => {
    expect(allows("evil.com", "=")).toBe(false);
  });

  it("never allows a raw IP literal", () => {
    expect(allows("1.2.3.4", LIST)).toBe(false);
    expect(allows("127.0.0.1", "=127.0.0.1")).toBe(false);
  });
});

describe("config contract", () => {
  it("both wrangler envs grant divinci.ai EXACTLY, never as a suffix", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["wrangler.production.toml", "wrangler.staging.toml"]) {
      const raw = readFileSync(join(__dirname, "..", f), "utf8");
      const m = raw.match(/^EGRESS_ALLOWED_HOSTS = "([^"]*)"/m);
      expect(m, `${f}: no EGRESS_ALLOWED_HOSTS`).toBeTruthy();
      const hosts = (m as RegExpMatchArray)[1].split(",").map((h) => h.trim());
      expect(hosts, `${f} must grant =divinci.ai`).toContain("=divinci.ai");
      // The failure this guards: someone "simplifies" the = away and silently
      // re-admits fulcrum-acme.divinci.ai.
      expect(hosts, `${f} must NOT list divinci.ai as a suffix entry`).not.toContain("divinci.ai");
    }
  });
});
