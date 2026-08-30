import type { HermesInstance } from '../hermesContainer';
import type { RateLimit } from './auth';
import { composeTerminalAllowlist } from './terminal';

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

  // Fleet claim ledger — one DO per fleet (see fleetCoordinator.ts). Optional
  // so a Worker deployed without the migration still boots; the routes 501
  // rather than throwing on an undefined binding.
  FLEET?: DurableObjectNamespace;

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

  /**
   * Wall-clock ceiling, in milliseconds, on a single hosted turn's
   * `containerFetch`. Default 600000 (10 min).
   *
   * ⚠️ THE PLATFORM DOES NOT BOUND THIS — we do. Cloudflare documents the
   * wall time of a Durable Object HTTP request as "unlimited while the caller
   * remains connected", so every ceiling on a wake is one of ours, and this
   * is the tightest.
   *
   * The number is NOT free to raise. The sweep that drives wakes
   * (`proactive-tick` in public-api) runs its agents SERIALLY inside one
   * request, and that request is made from the connector-sync-worker's
   * ten-minute (`*∕10`) cron branch — which Cloudflare caps at 15 minutes of wall clock,
   * shared with the Slack keepalive and the fleet digest either side of it,
   * and which fires again every 10 minutes. So the real budget is the cron
   * cadence, not the cron limit: 600000 lets one long agent use a whole
   * sweep while remaining unable to overlap the next firing. Raising it past
   * the cadence requires shortening the sweep's own deadline to compensate —
   * they are one setting in two places.
   */
  HERMES_TURN_TIMEOUT_MS?: string;

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

  // Buffer MCP (remote HTTP). Off unless "true". start-hermes.sh registers
  // mcp_servers.buffer → https://mcp.buffer.com/mcp with Bearer MCP_BUFFER_API_KEY.
  // Dogfood / Divinci-owned agents only — this is how changelog ideas get queued.
  HERMES_BUFFER_MCP_ENABLED?: string;
  /** Buffer Personal Access key. Prefer wrangler secret put MCP_BUFFER_API_KEY. */
  MCP_BUFFER_API_KEY?: string;

  // Canva MCP (remote HTTP). Off unless "true". start-hermes.sh registers
  // mcp_servers.canva → https://mcp.canva.com/mcp with auth: oauth, seeding the
  // token files from MCP_CANVA_OAUTH_JSON.
  //
  // ⚠️ Canva has NO static API key — the only credential is an OAuth grant, and
  // its access token lives 4 hours. So the seed must carry a refresh_token and
  // Hermes must own the refresh, which is why this ships token FILES rather
  // than an Authorization header like Buffer's.
  //
  // ⚠️ The grant seeded here must be its OWN authorization, not a copy of the
  // laptop's. Canva issues single-use refresh tokens: two holders of one grant
  // race, and the loser gets invalid_grant with no way to re-consent from a
  // headless container.
  HERMES_CANVA_MCP_ENABLED?: string;
  /**
   * JSON: {"client_id": "...", "refresh_token": "...", "access_token": "...",
   * "expires_at": <epoch seconds>}. Prefer wrangler secret put
   * MCP_CANVA_OAUTH_JSON. access_token/expires_at are optional — Hermes
   * refreshes from refresh_token on the first connect if they are absent.
   */
  MCP_CANVA_OAUTH_JSON?: string;

  // Divinci MCP (remote HTTP). Off unless "true". start-hermes.sh registers
  // mcp_servers.divinci → https://mcp.divinci.app/{whitelabelId}/mcp with
  // Bearer DIVINCI_API_KEY.
  //
  // This is how the agent gets web search and a guarded single-URL scrape at
  // all: Hermes has no web_search/web_fetch of its own, and the bounded
  // terminal is blocked from the open web by design.
  //
  // ⚠️ The tool surface is the union of `mcpConfig.exposedTools` across the
  // whitelabel's MCP-enabled releases, and an UNSET list means the whole
  // catalog — spend-marked tools, release_update, hermes_create and
  // hermes_proactive_set included. Curate the release's exposedTools before
  // enabling this; that allowlist is the entire boundary.
  //
  // ⚠️ Single-tenant, like the three above: this container is one Durable
  // Object with no whitelabel of its own, so enabling this binds the whole
  // container to ONE whitelabel. Divinci-owned deployments only.
  HERMES_DIVINCI_MCP_ENABLED?: string;
  /** The whitelabel whose MCP surface the agent gets. No default — it is per-tenant. */
  DIVINCI_WHITELABEL_ID?: string;
  /** Full endpoint override. Wins over DIVINCI_WHITELABEL_ID when set. */
  DIVINCI_MCP_URL?: string;
  /** Divinci API key. Prefer wrangler secret put DIVINCI_API_KEY. */
  DIVINCI_API_KEY?: string;
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
  if (env.HERMES_PROACTIVE_TOOLS_DISABLED) {
    keys.HERMES_PROACTIVE_TOOLS_DISABLED = env.HERMES_PROACTIVE_TOOLS_DISABLED;
  }
  // The egress allowlist must reach the CONTAINER, not just the Worker.
  //
  // start-hermes.sh now runs setup-terminal.sh at boot, and that script reads
  // EGRESS_ALLOWED_HOSTS from its own environment. A Worker [vars] entry is
  // NOT in the container process (the comment above says exactly this), so
  // without this the boot-time invocation sees an EMPTY allowlist and the
  // script logs:
  //
  //   WARNING: EGRESS_ALLOWED_HOSTS is empty — all terminal egress will be denied
  //
  // That is fail-closed and therefore safe, but it is not correct: it denies
  // github.com too, so `git_clone` and every package install break, and the
  // deployed allowlist becomes inert. Observed on staging 2026-08-21, in the
  // very boot log that proved the boundary works.
  //
  // ⚠️ composeTerminalAllowlist, NOT the raw var — it applies the same
  // Workspace/platform-CLI widenings the Worker route applies, so the two
  // paths cannot drift apart again. Divergence between them is the entire
  // defect this boundary work exists to fix.
  keys.EGRESS_ALLOWED_HOSTS = composeTerminalAllowlist({
    base: env.EGRESS_ALLOWED_HOSTS,
    workspaceCliEnabled: env.HERMES_WORKSPACE_CLI_ENABLED === "true",
    platformCliEnabled: env.HERMES_PLATFORM_CLI_ENABLED === "true",
  });
  if (env.HERMES_FULCRUM_MCP_ENABLED === "true" || env.HERMES_FULCRUM_MCP_ENABLED === "1") {
    keys.HERMES_FULCRUM_MCP_ENABLED = "true";
    if (env.FULCRUM_MCP_URL) keys.FULCRUM_MCP_URL = env.FULCRUM_MCP_URL;
    if (env.FULCRUM_API_TOKEN) keys.FULCRUM_API_TOKEN = env.FULCRUM_API_TOKEN;
    if (env.FULCRUM_CF_ACCESS_CLIENT_ID && env.FULCRUM_CF_ACCESS_CLIENT_SECRET) {
      keys.FULCRUM_CF_ACCESS_CLIENT_ID = env.FULCRUM_CF_ACCESS_CLIENT_ID;
      keys.FULCRUM_CF_ACCESS_CLIENT_SECRET = env.FULCRUM_CF_ACCESS_CLIENT_SECRET;
    }
  }
  if (env.HERMES_BUFFER_MCP_ENABLED === "true" || env.HERMES_BUFFER_MCP_ENABLED === "1") {
    keys.HERMES_BUFFER_MCP_ENABLED = "true";
    if (env.MCP_BUFFER_API_KEY) keys.MCP_BUFFER_API_KEY = env.MCP_BUFFER_API_KEY;
  }
  if (env.HERMES_CANVA_MCP_ENABLED === "true" || env.HERMES_CANVA_MCP_ENABLED === "1") {
    keys.HERMES_CANVA_MCP_ENABLED = "true";
    if (env.MCP_CANVA_OAUTH_JSON) keys.MCP_CANVA_OAUTH_JSON = env.MCP_CANVA_OAUTH_JSON;
  }
  if (env.HERMES_DIVINCI_MCP_ENABLED === "true" || env.HERMES_DIVINCI_MCP_ENABLED === "1") {
    keys.HERMES_DIVINCI_MCP_ENABLED = "true";
    // The whitelabel id is forwarded even though it is not a secret: the
    // endpoint is per-tenant and has no default, so without it start-hermes.sh
    // has no URL to register and skips.
    if (env.DIVINCI_WHITELABEL_ID) keys.DIVINCI_WHITELABEL_ID = env.DIVINCI_WHITELABEL_ID;
    if (env.DIVINCI_MCP_URL) keys.DIVINCI_MCP_URL = env.DIVINCI_MCP_URL;
    if (env.DIVINCI_API_KEY) keys.DIVINCI_API_KEY = env.DIVINCI_API_KEY;
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
