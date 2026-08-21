import type { HermesInstance } from '../hermesContainer';
import type { RateLimit } from './auth';

/**
 * Bindings exposed to the Worker via wrangler.toml.
 *
 * Required secrets (production):
 *   - One of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY
 *   - HERMES_GATEWAY_TOKEN   shared secret between the Worker and the Hermes API
 *                            server. Required — the container refuses to boot an
 *                            unauthenticated gateway. Generate: `openssl rand -hex 32`.
 *   - API_TOKEN and/or ADMIN_TOKEN — caller credentials. Without at least one,
 *     protected routes fail closed (503) unless ALLOW_UNAUTHENTICATED=true.
 *
 * Optional:
 *   - ADMIN_TOKEN            gates destructive control routes separately from chat.
 *   - ALLOW_UNAUTHENTICATED  set to "true" to run an open Worker (local dev only).
 *   - HERMES_DEFAULT_MODEL   default model id (e.g. `anthropic/claude-sonnet-4-5`)
 *   - DASHBOARD_HOSTNAME     hostname proxied to the dashboard (port 9119)
 *   - CHAT_RATE_LIMITER / ADMIN_RATE_LIMITER  native rate-limit bindings.
 */
export interface Env {
  HERMES: DurableObjectNamespace<HermesInstance>;

  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  // Nous Portal key — Hermes's default inference gateway (nousresearch/hermes-4-*
  // and many proxied models). Without it Hermes' default model 401s.
  NOUS_API_KEY?: string;

  // ── Platform (Divinci-paid) provider creds ────────────────────────────────
  // Identical for every agent — set once as Worker secrets, not per-request.
  // litellm routes to these by model-id prefix (`cloudflare/…`, `vertex_ai/…`),
  // so no header plumbing is needed; the container just needs the creds in env.

  // Cloudflare Workers AI (open models). Divinci's account + a Workers-AI-scoped
  // API token. litellm reads CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID.
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;

  // Vertex AI (Gemini). Divinci's GCP project + region + service-account JSON.
  // litellm mints AND refreshes the OAuth token from the SA JSON, so there is no
  // token-expiry problem for a long-lived container. VERTEX_SA_JSON is the inline
  // SA JSON (a wrangler secret); start-hermes.sh materializes it to a file and
  // points GOOGLE_APPLICATION_CREDENTIALS at it.
  VERTEXAI_PROJECT?: string;
  VERTEXAI_LOCATION?: string;
  VERTEX_SA_JSON?: string;

  API_TOKEN?: string;
  ADMIN_TOKEN?: string;
  ALLOW_UNAUTHENTICATED?: string;
  HERMES_GATEWAY_TOKEN?: string;
  HERMES_DEFAULT_MODEL?: string;
  DASHBOARD_HOSTNAME?: string;

  /**
   * Kill switch for the proactive tool tier. Set to "1"/"true" to stop
   * minting the reserved session key, dropping proactive wakes back to the
   * 15-tool unattended set WITHOUT a container rebuild or a public-api
   * deploy (Cloud Run is ~14 minutes; a Worker deploy is ~1).
   *
   * Deliberately a Worker-side switch rather than a public-api one: the
   * capability is granted here, so it must be revocable here. Same reasoning
   * as HERMES_PROACTIVE_DISABLED and HERMES_DIGEST_DISABLED on the Divinci
   * side — a capability with no fast off-switch is one you cannot safely
   * turn on.
   */
  HERMES_PROACTIVE_TOOLS_DISABLED?: string;

  // Hosted (multi-tenant) mode: shared secret proving the caller is Divinci's
  // public-api backend. When set, hosted routes require it AND a trusted agent
  // id; the DO/container is resolved per-agent. Absent ⇒ single-tenant mode.
  SERVICE_AUTH_SECRET?: string;

  CHAT_RATE_LIMITER?: RateLimit;
  ADMIN_RATE_LIMITER?: RateLimit;

  // ── Virtual terminal ──────────────────────────────────────────────────────
  // Comma-separated egress allowlist for terminal commands (exact host or
  // dot-anchored suffix). Unset ⇒ DEFAULT_EGRESS_ALLOWLIST in lib/terminal.ts
  // (package registries + forges). An EMPTY string is a valid deny-all posture,
  // NOT "allow everything" — the guard fails closed by design.
  EGRESS_ALLOWED_HOSTS?: string;

  // Google Workspace CLI (`gws`). Off unless explicitly "true". Enabling it
  // widens the container's egress allowlist to Google API hosts, so it is an
  // opt-in per deployment rather than a default.
  HERMES_WORKSPACE_CLI_ENABLED?: string;

  // Platform CLIs (`gcloud`, `wrangler`) already in the image. Off unless
  // "true". Enabling widens egress to GCP + Cloudflare API hosts (see
  // PLATFORM_EGRESS_HOSTS). Prefer dogfood / internal agents; customer agents
  // should stay closed until a short-lived token inject path exists.
  HERMES_PLATFORM_CLI_ENABLED?: string;

  // Virtual terminal MCP registration (divinci_terminal). Passed into the
  // container at gateway boot so start-hermes.sh can advertise the bounded
  // terminal tools. Worker-side terminal routes also gate on public-api flags.
  HERMES_TERMINAL_ENABLED?: string;

  // Hermes approvals.mode: manual | smart | off. Passed into start-hermes.sh.
  // Dogfood uses "off" (always-allow / YOLO). Customer multi-tenant should stay
  // "manual" so shell/execute_code cannot silently read ~/.hermes credentials.
  HERMES_APPROVALS_MODE?: string;

  // Comma-separated Hermes toolsets to remove, written to
  // `agent.disabled_toolsets`. "terminal,file" drops the BUILT-IN tools that
  // execute as the credential-owning `hermes` uid — notably `read_file`, which
  // returns ~/.hermes/.env in one call and which approvals.mode does not gate
  // (that is a shell-command gate). Shell and file work move to the bounded
  // terminal, which runs as uid 10002 and cannot read those files.
  //
  // Unset means unchanged, so an environment opts in explicitly.
  HERMES_DISABLED_TOOLSETS?: string;

  // Comma-separated toolsets Slack is ALLOWED, written to
  // `platform_toolsets.slack`. An allowlist, because the denylist above proved
  // insufficient on its own: it named terminal+file, and a Slack turn still
  // read ~/.hermes/.env through `execute_code` — a third toolset it did not
  // name, alongside browser_exec, computer_use, cronjob and delegate_task.
  //
  // MCP tools are NOT governed by toolsets, so the bounded terminal survives
  // this and keeps supplying shell/file work as uid 10002.
  HERMES_SLACK_TOOLSETS?: string;

  // Fulcrum MCP (remote HTTP). Off unless "true". When enabled, start-hermes.sh
  // registers mcp_servers.fulcrum → FULCRUM_MCP_URL with optional Bearer token.
  // ⚠️ A Fulcrum API token is code execution on the Fulcrum host (execute_command
  // etc.). Dogfood / Divinci-owned agents only — never enable for customer tenants.
  HERMES_FULCRUM_MCP_ENABLED?: string;
  /** Default: https://fulcrum-acme.divinci.ai/mcp */
  FULCRUM_MCP_URL?: string;
  /** fulc_… API token. Prefer wrangler secret put FULCRUM_API_TOKEN. */
  FULCRUM_API_TOKEN?: string;
  /** Optional CF Access service-token pair if Access starts requiring it. */
  FULCRUM_CF_ACCESS_CLIENT_ID?: string;
  FULCRUM_CF_ACCESS_CLIENT_SECRET?: string;
}

/**
 * Returns the single-tenant Durable Object stub for this deployment.
 * The deterministic name (`main`) means every request resolves to the same container.
 */
export function getContainer(env: Env): DurableObjectStub<HermesInstance> {
  const id = env.HERMES.idFromName('main');
  return env.HERMES.get(id);
}

/**
 * Error thrown when a request needs to reach the container but the Worker is
 * missing the shared gateway secret. Distinct type so routes can map it to a
 * clear 503 config error rather than a confusing 401/502 from the container.
 */
export class GatewayTokenMissingError extends Error {
  constructor() {
    super(
      'HERMES_GATEWAY_TOKEN is not set. Run `wrangler secret put HERMES_GATEWAY_TOKEN` ' +
        '(generate with `openssl rand -hex 32`). The container will not run an unauthenticated gateway.',
    );
    this.name = 'GatewayTokenMissingError';
  }
}

/**
 * Return the Worker↔container shared secret, or throw if unset. Every path that
 * boots or reaches the container must go through this so an unauthenticated
 * gateway can never be started or contacted with an empty token.
 */
export function requireGatewayToken(env: Env): string {
  const token = env.HERMES_GATEWAY_TOKEN;
  if (!token) throw new GatewayTokenMissingError();
  return token;
}

/**
 * Collect the BYOK provider keys from the environment so the Worker can pass
 * them on to the container at process start.
 */
export function collectProviderKeys(env: Env): Record<string, string> {
  const keys: Record<string, string> = {};
  if (env.ANTHROPIC_API_KEY) keys.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENROUTER_API_KEY) keys.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  if (env.OPENAI_API_KEY) keys.OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (env.GEMINI_API_KEY) {
    // Hermes/litellm read Gemini creds from GEMINI_API_KEY and/or GOOGLE_API_KEY;
    // set both so `google/…` and `gemini/…` model ids both authenticate.
    keys.GEMINI_API_KEY = env.GEMINI_API_KEY;
    keys.GOOGLE_API_KEY = env.GEMINI_API_KEY;
  }
  if (env.NOUS_API_KEY) keys.NOUS_API_KEY = env.NOUS_API_KEY;

  // Platform: Cloudflare Workers AI. Both the token AND the account id are
  // required by litellm — pass them only as a pair so a half-configured Worker
  // doesn't advertise a model it can't reach.
  if (env.CLOUDFLARE_API_KEY && env.CLOUDFLARE_ACCOUNT_ID) {
    keys.CLOUDFLARE_API_KEY = env.CLOUDFLARE_API_KEY;
    keys.CLOUDFLARE_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
  }

  // Platform: Vertex AI (Gemini). Project + location + SA JSON are all required;
  // pass as a set. start-hermes.sh turns VERTEX_SA_JSON into a credentials file.
  if (env.VERTEXAI_PROJECT && env.VERTEXAI_LOCATION && env.VERTEX_SA_JSON) {
    keys.VERTEXAI_PROJECT = env.VERTEXAI_PROJECT;
    keys.VERTEXAI_LOCATION = env.VERTEXAI_LOCATION;
    keys.VERTEX_SA_JSON = env.VERTEX_SA_JSON;
  }

  // Feature flags + Fulcrum MCP — must reach start-hermes.sh via startProcess env
  // (Worker [vars]/secrets do not automatically appear in the container process).
  if (env.HERMES_TERMINAL_ENABLED) {
    keys.HERMES_TERMINAL_ENABLED = env.HERMES_TERMINAL_ENABLED;
  }
  if (env.HERMES_APPROVALS_MODE) {
    keys.HERMES_APPROVALS_MODE = env.HERMES_APPROVALS_MODE;
  }
  if (env.HERMES_DISABLED_TOOLSETS) {
    keys.HERMES_DISABLED_TOOLSETS = env.HERMES_DISABLED_TOOLSETS;
  }
  if (env.HERMES_SLACK_TOOLSETS) {
    keys.HERMES_SLACK_TOOLSETS = env.HERMES_SLACK_TOOLSETS;
  }
  if (env.HERMES_FULCRUM_MCP_ENABLED === "true" || env.HERMES_FULCRUM_MCP_ENABLED === "1") {
    keys.HERMES_FULCRUM_MCP_ENABLED = "true";
    if (env.FULCRUM_MCP_URL) keys.FULCRUM_MCP_URL = env.FULCRUM_MCP_URL;
    if (env.FULCRUM_API_TOKEN) keys.FULCRUM_API_TOKEN = env.FULCRUM_API_TOKEN;
    if (env.FULCRUM_CF_ACCESS_CLIENT_ID && env.FULCRUM_CF_ACCESS_CLIENT_SECRET) {
      keys.FULCRUM_CF_ACCESS_CLIENT_ID = env.FULCRUM_CF_ACCESS_CLIENT_ID;
      keys.FULCRUM_CF_ACCESS_CLIENT_SECRET = env.FULCRUM_CF_ACCESS_CLIENT_SECRET;
    }
  }

  return keys;
}

const BYOK_ENV_BY_PROVIDER: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/**
 * Provider keys for boot, overlaying a per-agent BYOK key (from the
 * X-Hermes-Provider / X-Hermes-Provider-Key headers set by Divinci's backend)
 * on top of the platform keys. When present, the agent's container authenticates
 * to the LLM with the customer's own key.
 */
export function providerKeysWithByok(
  env: Env,
  byokProvider: string | null | undefined,
  byokKey: string | null | undefined,
): Record<string, string> {
  const keys = collectProviderKeys(env);
  if (byokProvider && byokKey) {
    const envName = BYOK_ENV_BY_PROVIDER[byokProvider];
    if (envName) {
      keys[envName] = byokKey;
      if (byokProvider === "gemini") keys.GOOGLE_API_KEY = byokKey;
    }
  }
  return keys;
}
