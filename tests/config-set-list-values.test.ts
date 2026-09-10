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

  it("both environments carry it", () => {
    // Was "staging yes, production no" during the staged rollout. Production
    // shipped 2026-08-14, after staging proved the mechanism: read_file absent
    // rather than merely guard-blocked, bounded terminal intact, agent still
    // completing real tool calls.
    //
    // Inverted rather than deleted. This is a security control that can be
    // removed by deleting one line from a toml. Reverting it during an incident
    // may well be the right call — but it should be a decision someone makes,
    // not a diff nobody notices.
    // Asserts the PROPERTY, not the literal value. The first version pinned
    // the exact string "terminal,file" and broke the moment that list was
    // widened to include code_execution — a test that fails when the control
    // gets STRONGER is a test that trains people to edit tests.
    for (const cfg of [staging, production]) {
      const value = cfg.match(/HERMES_DISABLED_TOOLSETS\s*=\s*"([^"]*)"/)?.[1];
      expect(value).toBeTruthy();
      expect(value!.split(",")).toEqual(expect.arrayContaining(["terminal", "file"]));
    }
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

describe("Slack toolset ALLOWLIST (the denylist was not enough)", () => {
  const staging = readFileSync(join(__dirname, "..", "wrangler.staging.toml"), "utf8");
  const production = readFileSync(join(__dirname, "..", "wrangler.production.toml"), "utf8");
  const allowlists = [staging, production];

  /**
   * 2026-08-14: `disabled_toolsets="terminal,file"` shipped, and a Slack smoke
   * test read ~/.hermes/.env anyway — via `execute_code`, a third toolset the
   * denylist did not name. These assertions encode that failure so the same
   * shape cannot come back.
   */
  it("names execute_code's toolset in every environment", () => {
    // The specific tool that defeated the first attempt.
    for (const cfg of allowlists) {
      expect(cfg).toMatch(/HERMES_DISABLED_TOOLSETS\s*=\s*"[^"]*code_execution/);
    }
  });

  it("grants Slack an explicit allowlist, not just a denylist", () => {
    // The structural fix. A denylist has to be updated in lockstep with every
    // upstream release to stay correct, and fails OPEN when it isn't.
    for (const cfg of allowlists) {
      expect(cfg).toMatch(/HERMES_SLACK_TOOLSETS\s*=\s*"[a-z_,]+"/);
    }
  });

  it("keeps every execution-capable toolset OUT of the allowlist", () => {
    // Enumerated from hermes-slack's tool list, not guessed: each of these
    // either executes code or schedules/delegates work that later does.
    const forbidden = [
      "code_execution", "terminal", "debugging", "file",
      "computer_use", "cronjob", "delegation", "browser",
    ];
    for (const cfg of allowlists) {
      const allow = cfg.match(/HERMES_SLACK_TOOLSETS\s*=\s*"([^"]*)"/)?.[1] ?? "";
      const entries = allow.split(",").map((s) => s.trim());
      for (const bad of forbidden) expect(entries).not.toContain(bad);
    }
  });

  it("still leaves Slack a usable agent", () => {
    // The inverse. An allowlist of [] would satisfy every assertion above while
    // making the agent useless — and "it refuses everything" and "it is
    // correctly restricted" look identical from a Slack message.
    for (const cfg of allowlists) {
      const allow = cfg.match(/HERMES_SLACK_TOOLSETS\s*=\s*"([^"]*)"/)?.[1] ?? "";
      const entries = allow.split(",").map((s) => s.trim()).filter(Boolean);
      expect(entries.length).toBeGreaterThanOrEqual(8);
      expect(entries).toContain("web");
      expect(entries).toContain("memory");
    }
  });

  it("does NOT disable the bounded terminal, which is an MCP server", () => {
    // Toolsets do not govern MCP tools, so shell and file work survive the
    // allowlist by design. If this ever fails, the change stopped re-routing
    // capability and started removing it.
    for (const cfg of allowlists) {
      expect(cfg).toMatch(/HERMES_TERMINAL_ENABLED\s*=\s*"true"/);
    }
    expect(startHermes).toContain('servers["divinci_terminal"]');
  });

  it("writes platform_toolsets.slack as a real list, with a read-back", () => {
    expect(startHermes).toContain('pt["slack"] = wanted');
    expect(startHermes).toContain("ok = isinstance(got, list) and got == wanted");
    // Other platforms must survive — this key is a dict of lists.
    expect(startHermes).toContain('pt = cfg.get("platform_toolsets")');
  });

  it("prints the UNSET case, naming what stays available", () => {
    // Same reason as disabled_toolsets: a silent absent case is
    // indistinguishable from a working one.
    expect(startHermes).toMatch(/platform_toolsets\.slack=UNSET/);
    expect(startHermes).toMatch(/execute_code included/);
  });
});
