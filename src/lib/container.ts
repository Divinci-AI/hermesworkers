import type { HermesInstance } from '../hermesContainer';

/**
 * Bindings exposed to the Worker via wrangler.toml.
 *
 * Required secrets:
 *   - One of ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY
 * Optional secrets:
 *   - API_TOKEN              bearer token required on /api/* if set
 *   - HERMES_GATEWAY_TOKEN   bearer token between Worker and Hermes API server
 *   - HERMES_DEFAULT_MODEL   default model id (e.g. `anthropic/claude-sonnet-4-5`)
 *   - DASHBOARD_HOSTNAME     hostname whose traffic should be proxied to the dashboard (port 9119)
 */
export interface Env {
  HERMES: DurableObjectNamespace<HermesInstance>;

  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;

  API_TOKEN?: string;
  HERMES_GATEWAY_TOKEN?: string;
  HERMES_DEFAULT_MODEL?: string;
  DASHBOARD_HOSTNAME?: string;
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
 * Collect the BYOK provider keys from the environment so the Worker can pass
 * them on to the container at process start.
 */
export function collectProviderKeys(env: Env): Record<string, string> {
  const keys: Record<string, string> = {};
  if (env.ANTHROPIC_API_KEY) keys.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY;
  if (env.OPENROUTER_API_KEY) keys.OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  if (env.OPENAI_API_KEY) keys.OPENAI_API_KEY = env.OPENAI_API_KEY;
  return keys;
}
