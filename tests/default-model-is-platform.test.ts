/**
 * The container's LAST-RESORT default model must be a PLATFORM model.
 *
 * `start-hermes.sh` picks `AGENT_MODEL` → `HERMES_DEFAULT_MODEL` → a hardcoded
 * literal. That literal fires precisely when the Worker has neither a per-agent
 * pin nor the HERMES_DEFAULT_MODEL secret — a Worker that has no reason to hold
 * a BYOK credential either. It was `anthropic/claude-sonnet-4-5` from the day it
 * shipped, so in the one situation it exists for it could only fail with a
 * missing ANTHROPIC_API_KEY.
 *
 * Nothing caught that because nothing asserted on it. This is that assertion.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(join(__dirname, "..", "container", "start-hermes.sh"), "utf8");

function fallbackLiteral(): string {
  const m = SCRIPT.match(/EFFECTIVE_MODEL="\$\{AGENT_MODEL:-\$\{HERMES_DEFAULT_MODEL:-([^}]+)\}\}"/);
  expect(m, "EFFECTIVE_MODEL precedence chain not found in start-hermes.sh").toBeTruthy();
  return (m as RegExpMatchArray)[1];
}

describe("container last-resort default model", () => {
  it("keeps the AGENT_MODEL -> HERMES_DEFAULT_MODEL -> literal precedence", () => {
    // A per-agent pin must still beat the Worker-wide secret; without this the
    // whole Worker answers Slack on one model regardless of each agent's choice.
    expect(SCRIPT).toContain('EFFECTIVE_MODEL="${AGENT_MODEL:-${HERMES_DEFAULT_MODEL:-');
  });

  it("falls back to a platform model, never to one needing a BYOK key", () => {
    const id = fallbackLiteral();
    expect(
      id.startsWith("cfai/@cf/") || id.startsWith("vertex_ai/"),
      `last-resort default "${id}" is a BYOK id. It fires only when the Worker ` +
        `holds no per-agent pin and no HERMES_DEFAULT_MODEL — such a Worker has ` +
        `no BYOK credential, so this can only fail. Use a cfai/ or vertex_ai/ id.`,
    ).toBe(true);
  });

  it("never names litellm's dead `cloudflare/` provider", () => {
    // Same trap the model catalog carries a guard for: litellm's built-in
    // cloudflare provider cannot parse today's Workers AI response body, so
    // every `cloudflare/@cf/...` id is dead on arrival. `cfai/` is the named
    // provider this same script registers a few lines above.
    expect(fallbackLiteral().startsWith("cloudflare/")).toBe(false);
  });

  it("names a model the cfai provider block can actually serve", () => {
    const id = fallbackLiteral();
    if (!id.startsWith("cfai/")) return;
    expect(SCRIPT).toContain('hermes config set providers.cfai.base_url');
    expect(SCRIPT).toContain('hermes config set providers.cfai.key_env');
  });
});
