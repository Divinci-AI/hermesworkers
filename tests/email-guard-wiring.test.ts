/**
 * Wiring tests for the divinci_email_guard plugin.
 *
 * The plugin's DECISION logic is tested in Python
 * (container/plugins/divinci_email_guard/test_policy.py, 74 cases). These
 * tests cover the half that Python cannot see: whether the plugin is
 * actually installed and enabled in the container.
 *
 * That split matters because the two halves fail differently. A broken
 * policy fails loudly — a tool that should work stops working. A broken
 * INSTALL fails silently: the plugin loader skips a plugin missing from
 * `plugins.enabled` with nothing but a DEBUG line, so the guard is absent
 * and everything looks normal. Every check below exists because its absence
 * would not be noticeable at runtime.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(__dirname, "..");
const read = (p: string) => readFileSync(join(repoRoot, p), "utf8");

const startHermes = read("container/start-hermes.sh");
const dockerfile = read("container/Dockerfile");

describe("divinci_email_guard: staged into the image", () => {
  it("copies the plugin into the read-only staging dir", () => {
    expect(dockerfile).toContain(
      "COPY plugins/divinci_email_guard /usr/local/share/divinci-hermes-plugins/divinci_email_guard",
    );
  });

  it("stages it root-owned so the hermes uid cannot rewrite its own guard", () => {
    // The `hermes` uid is what an injected agent runs as. If it could edit
    // the staging copy, the guard would be advisory rather than enforced.
    expect(dockerfile).toContain("chown -R root:root /usr/local/share/divinci-hermes-plugins");
  });
});

describe("divinci_email_guard: installed and ENABLED at boot", () => {
  it("installs the plugin into the Hermes plugins dir", () => {
    expect(startHermes).toContain("GUARD_SRC=");
    expect(startHermes).toContain("plugins/divinci_email_guard");
    expect(startHermes).toMatch(/cp -R "\$GUARD_SRC" "\$GUARD_DEST"/);
  });

  it("writes plugins.enabled as YAML, not via `hermes config set`", () => {
    // 2026-08-14: `hermes config set plugins.enabled '["divinci_email_guard"]'`
    // stored the value as a STRING. `_get_enabled_plugins()` requires a list
    // (`isinstance(enabled, list)`) and returns None otherwise — meaning
    // "nothing enabled". The command reported success, the key was present,
    // and the guard silently never loaded.
    // Matches an EXECUTED line only — the explanatory comment above the fix
    // quotes the broken command on purpose, and must not trip this.
    expect(startHermes).not.toMatch(/^\s*hermes config set plugins\.enabled/m);
    expect(startHermes).toContain("HERMES_CFG=");
    expect(startHermes).toContain("yaml.safe_dump");
  });

  it("appends to plugins.enabled rather than overwriting it", () => {
    // Overwriting would silently disable any other plugin someone enabled.
    expect(startHermes).toContain('if "divinci_email_guard" not in enabled');
    expect(startHermes).toContain("enabled.append");
  });

  it("reads the config back and logs the PARSED TYPE, not the attempt", () => {
    // The failure this exists to prevent: the boot log said
    // "installed + enabled" while nothing was enabled. A log line that
    // reports what was attempted rather than what is true is worse than none,
    // because it actively misdirects the next person debugging.
    expect(startHermes).toContain("enabled={'OK' if ok else 'FAILED'}");
    expect(startHermes).toContain("type={type(got).__name__}");
  });

  it("derives paths from HOME_DIR, as the rest of the script does", () => {
    // HERMES_HOME is not set in the image, so reading it works only by
    // falling through to a hardcoded default — which diverges silently the
    // moment a profile sets it.
    expect(startHermes).toContain('GUARD_DEST="$HOME_DIR/.hermes/plugins/divinci_email_guard"');
    expect(startHermes).not.toContain("${HERMES_HOME:-");
  });

  it("reinstalls from staging on every boot, so a modified copy cannot persist", () => {
    expect(startHermes).toMatch(/rm -rf "\$GUARD_DEST"/);
  });

  it("warns loudly when the plugin is missing rather than booting quietly", () => {
    expect(startHermes).toMatch(/WARNING: divinci_email_guard NOT FOUND/);
    expect(startHermes).toMatch(/UNGUARDED/);
  });

  it("records the file install in the boot log so its absence is diagnosable", () => {
    // Deliberately says "files installed" and nothing about being ENABLED —
    // the enable status is reported separately, from a read-back. The old
    // wording ("installed + enabled") asserted both from one action and was
    // false for hours.
    expect(startHermes).toContain("[startup] divinci_email_guard files installed");
  });
});

describe("divinci_email_guard: the reasoning survives an edit", () => {
  it("records that approvals.mode does NOT gate MCP calls", () => {
    // This is the finding the whole plugin rests on, and it is
    // counter-intuitive: approvals.mode is set to "manual" fifteen lines
    // above and looks like it covers this. Someone deleting the plugin
    // because "approvals already handle it" is the specific regression.
    expect(startHermes).toMatch(/approvals\.mode above does NOT gate MCP tool calls/);
  });

  it("names the two callers that approvals.mode actually reaches", () => {
    expect(startHermes).toContain("check_all_command_guards");
    expect(startHermes).toContain("check_execute_code_guard");
  });
});
