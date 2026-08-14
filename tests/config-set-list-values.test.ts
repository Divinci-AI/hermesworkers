/**
 * Guard against a whole BUG CLASS: writing a list-valued Hermes config key
 * with `hermes config set`.
 *
 * `set_config_value` (hermes_cli/config.py) coerces exactly three things —
 * "true"/"false", integers, and floats. There is no JSON or YAML parsing. So
 *
 *     hermes config set some.key '["a"]'
 *
 * stores the literal STRING `["a"]`, the command prints a tick, and the
 * consumer — which type-checks for a list — silently sees nothing valid.
 *
 * This has now bitten twice, in the two places it could do the most damage,
 * and both times it disabled a SECURITY control while leaving the agent fully
 * functional:
 *
 *   plugins.enabled  — `_get_enabled_plugins()` does `isinstance(enabled,
 *                      list)` and returns None otherwise, so the email guard
 *                      was installed, reported enabled, and never loaded.
 *
 *   mcp_servers.divinci_terminal.args
 *                    — `mcp_tool.py` splats it as `[command, *args]`, and
 *                      splatting a STRING iterates it character by character.
 *                      node was launched with `[` as its script path plus 41
 *                      one-character arguments, died instantly, and the
 *                      bounded terminal never connected — 1,472 log lines of
 *                      "failed initial connection". The agent kept working
 *                      because Hermes' BUILT-IN terminal took over, running as
 *                      the uid that owns every provider credential. The
 *                      containment was gone; the capability was not.
 *
 * That is the shape to keep out: the failure removes the boundary and leaves
 * the feature, so nothing looks wrong from the outside.
 *
 * The fix in both cases is to write the YAML with Hermes' own parser and read
 * the value back, asserting its TYPE.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const startHermes = readFileSync(
  join(__dirname, "..", "container", "start-hermes.sh"),
  "utf8",
);

describe("no list-valued key is written via `hermes config set`", () => {
  it("has no `hermes config set <key> '[...]'` anywhere in the boot script", () => {
    // Matches a config set whose value begins with a bracket, on any key —
    // the point is to catch the NEXT one, not to re-catch the two known ones.
    const offenders = startHermes
      .split("\n")
      // Comments are excluded, not the pattern widened: this file DOCUMENTS
      // the broken form in prose, and a rule loosened enough to accept that
      // prose would also accept the real thing. A shell command never begins
      // with `#`.
      .filter((line) => !/^\s*#/.test(line))
      // Any quoting style, or none. The first version of this test matched
      // only `'[`, and missed a live third instance —
      // `hermes config set command_allowlist "[]"` — sitting in committed
      // code the whole time, because it used double quotes.
      .filter((line) => /hermes\s+config\s+set\s+\S+\s+["']?\[/.test(line));
    expect(offenders).toEqual([]);
  });
});

describe("divinci_terminal: registered with a real list", () => {
  it("writes mcp_servers config as YAML through the python parser", () => {
    expect(startHermes).toMatch(/mcp_servers.*=.*servers|servers\["divinci_terminal"\]/s);
    expect(startHermes).toContain('"args": [SERVER]');
  });

  it("reads the value back and asserts it is a list", () => {
    // The read-back is the part that would have caught this in a boot log.
    expect(startHermes).toContain("isinstance(got, list)");
    expect(startHermes).toContain("type={type(got).__name__}");
  });

  it("preserves other MCP servers rather than replacing the section", () => {
    // fulcrum is registered further down. A write that replaced mcp_servers
    // wholesale would silently unregister it — and, being a separate control
    // surface, that would not be visible from the terminal's own behaviour.
    expect(startHermes).toContain('servers = cfg.get("mcp_servers")');
    expect(startHermes).toContain("if not isinstance(servers, dict):");
  });

  it("STILL registers the bounded terminal at all", () => {
    // The inverse assertion, per the standing rule for this container: a boot
    // script that had simply dropped divinci_terminal would satisfy every
    // check above while leaving the agent on the unbounded built-in terminal —
    // which is the exact state this change exists to end.
    expect(startHermes).toContain('servers["divinci_terminal"]');
    expect(startHermes).toContain("/usr/local/bin/mcp-terminal-server.js");
  });

  it("drops the inert mcp-terminal.yaml sidecar", () => {
    // Hermes reads config.yaml; that file was never merged. Leaving it would
    // present a correct-looking list to anyone debugging the wrong file.
    expect(startHermes).toContain("rm -f");
    expect(startHermes).not.toMatch(/cat > "\$MCP_CFG"/);
  });
});

describe("disabled_toolsets: the built-in credential-owning tools", () => {
  const staging = readFileSync(
    join(__dirname, "..", "wrangler.staging.toml"),
    "utf8",
  );
  const production = readFileSync(
    join(__dirname, "..", "wrangler.production.toml"),
    "utf8",
  );

  it("writes agent.disabled_toolsets as YAML, with a read-back type assertion", () => {
    // Fourth list-valued key in this script. `hermes config set` would store a
    // string and gateway/run.py's `agent_cfg.get("disabled_toolsets")` would
    // then hand a string to the toolset resolver — the same silent no-op that
    // disabled the plugin and the bounded terminal.
    expect(startHermes).toContain('agent["disabled_toolsets"] = wanted');
    expect(startHermes).toContain("ok = isinstance(got, list) and got == wanted");
  });

  it("preserves other keys in the `agent` section", () => {
    expect(startHermes).toContain('agent = cfg.get("agent")');
    expect(startHermes).toContain("if not isinstance(agent, dict):");
  });

  it("is opt-in — an environment that does not set it is unchanged", () => {
    // The blast radius control. This removes tools from the INTERACTIVE path,
    // so it must never switch itself on by default.
    expect(startHermes).toMatch(/if \[ -n "\$\{HERMES_DISABLED_TOOLSETS:-\}" \]; then/);
    expect(startHermes).toContain("disabled_toolsets=UNSET");
  });

  it("staging carries it and production does NOT (yet)", () => {
    // Staging-first was the explicit decision. If this ever fails because
    // production gained the var, that is fine — delete the assertion in the
    // same commit that ships it, having verified Slack on staging first.
    expect(staging).toMatch(/HERMES_DISABLED_TOOLSETS\s*=\s*"terminal,file"/);
    expect(production).not.toMatch(/^\s*HERMES_DISABLED_TOOLSETS/m);
  });

  it("does not disable the BOUNDED terminal along with the built-in one", () => {
    // `terminal` here is Hermes' built-in toolset. The bounded terminal is an
    // MCP server (divinci_terminal) and is registered separately — disabling
    // the built-in must not take it down, or the change removes the capability
    // instead of re-routing it, which is the difference between hardening and
    // breaking.
    expect(staging).toMatch(/HERMES_TERMINAL_ENABLED\s*=\s*"true"/);
    expect(startHermes).toContain('servers["divinci_terminal"]');
  });
});
