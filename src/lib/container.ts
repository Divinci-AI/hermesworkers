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

  // Hosted (multi-tenant) mode: shared secret proving the caller is Divinci's
  // public-api backend. When set, hosted routes require it AND a trusted agent
  // id; the DO/container is resolved per-agent. Absent ⇒ single-tenant mode.
  SERVICE_AUTH_SECRET?: string;

  CHAT_RATE_LIMITER?: RateLimit;
  ADMIN_RATE_LIMITER?: RateLimit;
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
