/**
 * Per-agent identity + model apply for hosted multi-tenant agents.
 *
 * WHY THIS EXISTS
 * ---------------
 * Divinci stores a `systemPrompt` and `hermesModel` per agent, but until now
 * NEITHER reached the container. `applyAgentConfig` on the public-api side
 * injects them into the request body of `/hosted/agent/v1/chat/completions`,
 * which only covers chats that go THROUGH Divinci. A Slack message never does —
 * it arrives at the container's own Hermes gateway over Socket Mode, which
 * composes the reply from the container's own config.
 *
 * The visible symptoms:
 *   - The agent introduced itself as stock "Hermes Agent by Nous Research" in
 *     Slack no matter what persona was set in Divinci.
 *   - Every agent on a Worker answered Slack on the SAME model, because the
 *     gateway model came from the Worker-wide HERMES_DEFAULT_MODEL secret
 *     rather than the agent's own `hermesModel`.
 *
 * This route closes both, using the same durable-file pattern as slack.env:
 * write under ~/.hermes so `start-hermes.sh` re-applies on every cold boot,
 * rather than relying on state that a sleeping container forgets.
 *
 * SOUL.md is Hermes' identity file — it occupies slot #1 of the system prompt
 * and REPLACES the built-in identity, which is exactly the hook we want.
 */

/** Durable persona file, re-read by start-hermes.sh on every boot. */
export const SOUL_RELATIVE_PATH = '.hermes/SOUL.md';
export const SOUL_ABSOLUTE = `/home/hermes/${SOUL_RELATIVE_PATH}`;
/** Durable model pin, sourced by start-hermes.sh before `hermes config set model`. */
export const AGENT_MODEL_ENV_ABSOLUTE = '/home/hermes/.hermes/divinci-platforms/model.env';

export interface AgentConfigBody {
  /** Agent persona. Empty string clears it (reverts to Hermes' built-in identity). */
  systemPrompt?: string;
  /**
   * Hermes-native model id. NOTE the namespace mismatch this has to survive:
   * Divinci ids are litellm-style (`vertex_ai/gemini-2.5-flash`) while Hermes
   * wants its own slug. We pass through verbatim and let Hermes resolve — an
   * unresolvable id is what produced `Current: unknown on OpenRouter`, so the
   * CALLER is responsible for sending something Hermes understands.
   */
  model?: string;
}

export type AgentConfigParse =
  | { ok: true; body: AgentConfigBody }
  | { ok: false; status: 400; error: string };

/** Cap the persona so a runaway prompt cannot fill the container's disk. */
const MAX_SOUL_CHARS = 20_000;

export function parseAgentConfigBody(raw: unknown): AgentConfigParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  const body: AgentConfigBody = {};

  if (o.systemPrompt !== undefined && o.systemPrompt !== null) {
    if (typeof o.systemPrompt !== 'string') {
      return { ok: false, status: 400, error: 'systemPrompt must be a string' };
    }
    if (o.systemPrompt.length > MAX_SOUL_CHARS) {
      return { ok: false, status: 400, error: `systemPrompt must be ${MAX_SOUL_CHARS} chars or fewer` };
    }
    body.systemPrompt = o.systemPrompt;
  }

  if (o.model !== undefined && o.model !== null) {
    if (typeof o.model !== 'string') {
      return { ok: false, status: 400, error: 'model must be a string' };
    }
    const m = o.model.trim();
    if (!m) return { ok: false, status: 400, error: 'model must not be empty' };
    if (m.length > 200) return { ok: false, status: 400, error: 'model is too long' };
    // The value lands in a shell single-quoted string; a quote would break out.
    if (m.includes("'") || /\s/.test(m)) {
      return { ok: false, status: 400, error: 'model contains invalid characters' };
    }
    body.model = m;
  }

  if (body.systemPrompt === undefined && body.model === undefined) {
    return { ok: false, status: 400, error: 'at least one of systemPrompt or model is required' };
  }
  return { ok: true, body };
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/**
 * Shell run as root that writes the durable identity + model files.
 *
 * The persona is base64'd for the same reason the Slack tokens are: a persona
 * is free text and WILL eventually contain quotes, backticks and newlines.
 */
export function buildAgentConfigShell(body: AgentConfigBody): string {
  const home = '/home/hermes';
  const dir = `${home}/.hermes/divinci-platforms`;
  const lines: string[] = ['set -euo pipefail', `mkdir -p ${shellSingleQuote(dir)}`];

  if (body.systemPrompt !== undefined) {
    if (body.systemPrompt.trim() === '') {
      // Empty means "revert to Hermes' built-in identity". Hermes falls back
      // when SOUL.md is absent, so removing it is the correct clear.
      lines.push(`rm -f ${shellSingleQuote(SOUL_ABSOLUTE)}`);
      lines.push('echo "soul_cleared=1"');
    } else {
      lines.push(
        `printf %s ${shellSingleQuote(utf8ToBase64(body.systemPrompt))} | base64 -d > ${shellSingleQuote(SOUL_ABSOLUTE)}`,
        `chmod 600 ${shellSingleQuote(SOUL_ABSOLUTE)}`,
        `wc -c < ${shellSingleQuote(SOUL_ABSOLUTE)} | tr -d ' ' | xargs -I{} echo "soul_bytes={}"`,
      );
    }
  }

  if (body.model !== undefined) {
    lines.push(
      `printf 'HERMES_AGENT_MODEL=%s\\n' ${shellSingleQuote(body.model)} > ${shellSingleQuote(AGENT_MODEL_ENV_ABSOLUTE)}`,
      `chmod 600 ${shellSingleQuote(AGENT_MODEL_ENV_ABSOLUTE)}`,
      // Apply immediately too, so a running gateway picks it up without a boot.
      `hermes config set model ${shellSingleQuote(body.model)} 2>/dev/null || true`,
      `echo "model_set=${body.model}"`,
    );
  }

  lines.push(
    `chown -R hermes:hermes ${shellSingleQuote(`${home}/.hermes`)} 2>/dev/null || true`,
    'echo "agent_config_ok=1"',
  );
  return lines.join('\n');
}
