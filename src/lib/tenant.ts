/**
 * Multi-tenant (hosted) resolution and isolation.
 *
 * In hosted mode one Divinci-operated Worker serves many agents. Each agent maps
 * to its own Durable Object (⇒ its own Sandbox container) keyed by `agentId`, so
 * agents never share state or compute.
 *
 * ISOLATION INVARIANT: the `agentId` used to resolve a DO must come from a
 * server-trusted source — Divinci's public-api, after Auth0 + ownership checks —
 * carried in the `X-Divinci-Agent-Id` header on a service-authenticated request.
 * A client must never be able to name another tenant's agent. This module treats
 * the id as untrusted anyway (strict validation) as defense-in-depth: even if a
 * bad id slipped through, it cannot become a path-traversal / injection / DO-name
 * confusion vector.
 */

import type { HermesInstance } from '../hermesContainer';
import type { Env } from './container';
import { timingSafeEqual, extractBearer } from './auth';

export const SERVICE_AGENT_HEADER = 'x-divinci-agent-id';

/**
 * Strict agent-id format: lowercase hex/uuid-ish, 8–64 chars of [a-z0-9-].
 * Deliberately narrow — DO names are opaque strings, but constraining the input
 * removes any ambiguity and keeps ids log-safe and URL-safe.
 */
const AGENT_ID_RE = /^[a-z0-9](?:[a-z0-9-]{6,62}[a-z0-9])$/;

export function isValidAgentId(id: unknown): id is string {
  return typeof id === 'string' && id.length >= 8 && id.length <= 64 && AGENT_ID_RE.test(id);
}

export interface AgentResolution {
  ok: boolean;
  agentId?: string;
  status?: number;
  error?: string;
}

/** Validate and normalize the trusted agent-id header. */
export function resolveAgentId(header: string | null): AgentResolution {
  const raw = (header || '').trim();
  if (!raw) return { ok: false, status: 400, error: 'missing_agent_id' };
  if (!isValidAgentId(raw)) return { ok: false, status: 400, error: 'invalid_agent_id' };
  return { ok: true, agentId: raw };
}

/**
 * Resolve the per-agent Durable Object stub. Throws on an invalid id so a
 * resolution can never silently fall back to a shared/default container.
 */
export function getContainerForAgent(
  env: Env,
  agentId: string,
): DurableObjectStub<HermesInstance> {
  if (!isValidAgentId(agentId)) {
    throw new Error(`Refusing to resolve container for invalid agentId: ${JSON.stringify(agentId)}`);
  }
  // Namespaced so a hosted agent id can never collide with the single-tenant
  // 'main' instance or any future reserved name.
  const id = env.HERMES.idFromName(`agent:${agentId}`);
  return env.HERMES.get(id);
}

export interface ServiceAuthOutcome {
  ok: boolean;
  status?: number;
  error?: string;
  agentId?: string;
}

/**
 * Authenticate a hosted request: the caller must present the service secret
 * (constant-time) AND a well-formed trusted agent id. Returns the validated
 * agentId on success. Only Divinci's backend ever calls this path.
 */
export async function checkServiceAuth(
  env: Env,
  authorizationHeader: string | null,
  agentIdHeader: string | null,
): Promise<ServiceAuthOutcome> {
  const secret = env.SERVICE_AUTH_SECRET;
  if (!secret) return { ok: false, status: 503, error: 'hosted_mode_not_configured' };

  const provided = extractBearer(authorizationHeader);
  if (!provided || !(await timingSafeEqual(provided, secret))) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }

  const agent = resolveAgentId(agentIdHeader);
  if (!agent.ok) return { ok: false, status: agent.status, error: agent.error };

  return { ok: true, agentId: agent.agentId };
}
