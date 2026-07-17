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
  return keys;
}
