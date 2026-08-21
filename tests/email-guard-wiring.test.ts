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

/**
 * ── The PROACTIVE trust tier ──────────────────────────────────────────────
 *
 * The guard widens an unattended turn's toolset when the container sees the
 * session key `divinci-internal-proactive`. Whether a value in that namespace
 * can REACH the container is therefore the security boundary, and it lives
 * here in the Worker rather than in the Python policy — which cannot see it.
 *
 * Two rules, and neither is sufficient alone:
 *   1. the customer-facing proxy REFUSES the reserved namespace;
 *   2. the internal chat route MINTS it, only from `X-Divinci-Trigger`.
 *
 * Rule 1 is the one that is easy to lose: `/hosted/agent/proxy/*` forwards
 * `x-hermes-session-key` VERBATIM from the caller, and `/api/v1/hermes-proxy`
 * reads it straight off the customer's request headers. Delete rule 1 and any
 * customer holding a proxy key can hand themselves the bounded terminal.
 */
describe("the proactive tier's trust signal", () => {
  const hosted = read("src/routes/hosted.ts");

  it("REFUSES a reserved session key on the customer-facing proxy", () => {
    expect(hosted).toContain("isReservedSessionKey(sessionKey)");
    expect(hosted).toContain("reserved_session_key");
  });

  it("refuses BEFORE forwarding the header, not after", () => {
    // Order is the whole control: a check placed after the `headers.set`
    // would 400 the response while the container had already been handed
    // the widened signal on a prior line.
    const refusal = hosted.indexOf("isReservedSessionKey(sessionKey)");
    const forward = hosted.indexOf("headers.set('x-hermes-session-key', sessionKey)");
    expect(refusal).toBeGreaterThan(-1);
    expect(forward).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(forward);
  });

  it("matches the whole reserved NAMESPACE, not just the one live value", () => {
    // A future second signal (…-replay, …-eval) must be refused the day it
    // is added, not the day someone remembers to extend this list.
    expect(hosted).toContain("const DIVINCI_INTERNAL_SESSION_PREFIX = 'divinci-internal-'");
    expect(hosted).toMatch(/startsWith\(DIVINCI_INTERNAL_SESSION_PREFIX\)/);
  });

  it("MINTS the key rather than forwarding one the caller supplied", () => {
    // The caller controls only a trigger NAME, compared against one literal.
    // If this ever became a forward, the trigger would turn into a
    // capability token that any /hosted caller could present.
    expect(hosted).toMatch(/x-divinci-trigger'\s*\)\s*\?\?\s*''\)\.trim\(\)\.toLowerCase\(\)\s*===\s*'proactive'/);
    expect(hosted).toContain("upstreamHeaders['X-Hermes-Session-Key'] = PROACTIVE_SESSION_KEY");
  });

  it("uses the SAME literal the Python policy compares against", () => {
    // Two repos, two languages, one string. A drift here fails closed and
    // silently: the fleet quietly keeps the 15-tool set and nothing errors.
    const policy = read("container/plugins/divinci_email_guard/policy.py");
    expect(hosted).toContain("const PROACTIVE_SESSION_KEY = 'divinci-internal-proactive'");
    expect(policy).toContain('PROACTIVE_SESSION_KEY = "divinci-internal-proactive"');
  });
});

/**
 * ── The dependency that would 403 every wake ──────────────────────────────
 *
 * `X-Hermes-Session-Key` is not merely ignored when the API server has no
 * key configured — `_parse_session_key_header` returns **HTTP 403** and the
 * whole turn fails:
 *
 *     "X-Hermes-Session-Key requires API key authentication.
 *      Configure API_SERVER_KEY to enable this feature."
 *
 * So the proactive tier does not degrade to the narrow toolset if
 * API_SERVER_KEY goes missing — every proactive wake starts failing
 * outright, while Slack and email keep working, because they send no
 * session key. That asymmetry is exactly what makes it hard to diagnose.
 */
describe("the proactive tier's prerequisite", () => {
  it("sets API_SERVER_KEY, without which the session key 403s the turn", () => {
    expect(startHermes).toMatch(/hermes config set API_SERVER_KEY\s+"\$\{HERMES_GATEWAY_TOKEN\}"/);
  });

  it("ships the plugin into the image, so a Worker deploy carries it", () => {
    // The plugin is COPYd at build time and re-installed from that
    // root-owned copy on every boot. Editing it without a rebuild changes
    // nothing the container runs.
    expect(dockerfile).toContain(
      "COPY plugins/divinci_email_guard /usr/local/share/divinci-hermes-plugins/divinci_email_guard",
    );
  });
});
