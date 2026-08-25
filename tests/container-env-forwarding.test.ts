/**
 * Every `HERMES_*` the boot script reads must actually REACH the container.
 *
 * Worker `[vars]` and secrets do NOT appear in the container process. They are
 * forwarded explicitly — through `collectProviderKeys()` (spread into
 * `envVars`) or as a named option in `container-lifecycle.ts`. A flag that is
 * set in wrangler.toml but never forwarded is read as unset by
 * `start-hermes.sh`, which means the feature silently does not happen.
 *
 * That is not hypothetical. `HERMES_DISABLED_TOOLSETS` was added to
 * `wrangler.staging.toml`, deployed, and the image verifiably propagated — and
 * the boot log still said:
 *
 *     [startup] disabled_toolsets=UNSET — built-in terminal/file tools remain available
 *
 * The deploy succeeded, the new image was running, and the security control it
 * carried did nothing. It was caught only because that UNSET branch prints at
 * all; a flag whose absent case is silent would have looked identical to a
 * working one.
 *
 * So: this test, and keep printing the negative case.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const startHermes = read("container/start-hermes.sh");
const containerLib = read("src/lib/container.ts");
const lifecycle = read("src/services/container-lifecycle.ts");

/**
 * Read by the script but deliberately NOT forwarded from the Worker. Each entry
 * needs a reason — the point is to force a decision, not to keep a list.
 */
const NOT_FORWARDED: Record<string, string> = {
  // Passed as named options on startProcess, not via providerKeys.
  HERMES_GATEWAY_TOKEN: "explicit option in container-lifecycle envVars",
  HERMES_DEFAULT_MODEL: "explicit option in container-lifecycle envVars",
  // Script-local knobs with in-script defaults; nothing Worker-side sets them.
  HERMES_ENV_FILE: "script-local path, defaulted inside start-hermes.sh",
  HERMES_SHRED_ENV: "script-local flag, defaulted inside start-hermes.sh",
  // Defaults to /workspace inside start-hermes.sh, which is the only directory
  // the terminal can write and the gateway can read. Deliberately NOT
  // Worker-settable: it is the allowlist of directories whose files may be
  // delivered out to Slack, so a remotely-settable value would let a Worker
  // var change widen what can leave the container.
  HERMES_MEDIA_ALLOW_DIRS: "in-script default /workspace; not remotely settable by design",
};

const readByScript = [
  ...new Set(
    (startHermes.match(/\$\{(HERMES_[A-Z0-9_]+)/g) || []).map((m) =>
      m.replace("${", ""),
    ),
  ),
].sort();

describe("HERMES_* flags reach the container", () => {
  it("finds the flags the boot script actually reads", () => {
    // Sanity: if this regex ever stops matching, every assertion below passes
    // vacuously — the classic way a guard goes quiet.
    expect(readByScript.length).toBeGreaterThan(4);
    expect(readByScript).toContain("HERMES_DISABLED_TOOLSETS");
  });

  it.each(readByScript)("%s is forwarded, or documented as not", (name) => {
    const forwarded =
      containerLib.includes(`keys.${name} =`) ||
      lifecycle.includes(`envVars.${name} =`);
    if (forwarded) return;
    expect(
      NOT_FORWARDED[name],
      `${name} is read by start-hermes.sh but never reaches the container. ` +
        `Forward it in collectProviderKeys(), or add it to NOT_FORWARDED with a reason.`,
    ).toBeTruthy();
  });

  it("declares HERMES_DISABLED_TOOLSETS on the Env interface", () => {
    // Without the field, `env.HERMES_DISABLED_TOOLSETS` is a type error under
    // strict mode — or worse, silently `undefined` if someone casts around it.
    expect(containerLib).toMatch(/HERMES_DISABLED_TOOLSETS\?: string;/);
  });

  it("keeps printing the UNSET case in the boot log", () => {
    // The only reason the staging miss was visible at all.
    expect(startHermes).toContain("disabled_toolsets=UNSET");
  });
});

/**
 * ── Non-HERMES_ vars the boot script reads ────────────────────────────────
 *
 * The scan above only walks `HERMES_*` names, so a var with any other prefix
 * can be read by start-hermes.sh and silently never forwarded. That happened
 * the day the boot script started establishing the terminal boundary:
 * EGRESS_ALLOWED_HOSTS is a Worker [vars] entry, is NOT in the container
 * process, and the script logged
 *
 *   WARNING: EGRESS_ALLOWED_HOSTS is empty — all terminal egress will be denied
 *
 * which is fail-closed (safe) but wrong — it denies github.com too, so
 * git_clone and every package install break while the deployed allowlist sits
 * inert. Nothing failed; the boundary came up looking correct.
 */
describe("egress vars reach the container", () => {
  it("forwards EGRESS_ALLOWED_HOSTS", () => {
    expect(containerLib).toMatch(/keys\.EGRESS_ALLOWED_HOSTS\s*=/);
  });

  it("forwards it through composeTerminalAllowlist, not the raw var", () => {
    // Both routes must compose the list identically. Passing the raw var here
    // would drop the Workspace/platform-CLI widenings on the boot path only —
    // re-creating, in miniature, the divergence this whole fix addresses.
    expect(containerLib).toMatch(/EGRESS_ALLOWED_HOSTS\s*=\s*composeTerminalAllowlist\(/);
  });

  it("start-hermes.sh actually reads it", () => {
    expect(startHermes).toMatch(/EGRESS_ALLOWED_HOSTS=/);
  });

  it("forwards the proactive kill switch too", () => {
    expect(containerLib).toMatch(/keys\.HERMES_PROACTIVE_TOOLS_DISABLED\s*=/);
  });
});
