/**
 * Hosted (multi-tenant) routes. Mounted under /hosted/* only when
 * SERVICE_AUTH_SECRET is configured. Every request is service-authenticated
 * (Divinci public-api is the only caller) and scoped to ONE agent's Durable
 * Object / Sandbox container, resolved from the trusted X-Divinci-Agent-Id
 * header. Container calls are wrapped in withRetry for transient-failure
 * resilience.
 */

import { Hono } from 'hono';
import type { Env } from '../lib/container';
import { collectProviderKeys, requireGatewayToken } from '../lib/container';
import {
  checkServiceAuth,
  getContainerForAgent,
  SERVICE_AGENT_HEADER,
} from '../lib/tenant';
import { withRetry } from '../lib/resilience';
import { ensureGateway, HERMES_API_PORT } from '../services/container-lifecycle';

type HostedCtx = { Bindings: Env; Variables: { agentId: string } };

const hosted = new Hono<HostedCtx>();

// Service-auth gate for the whole group. Stashes the validated agentId.
hosted.use('/hosted/*', async (c, next) => {
  const outcome = await checkServiceAuth(
    c.env,
    c.req.header('authorization') ?? null,
    c.req.header(SERVICE_AGENT_HEADER) ?? null,
  );
  if (!outcome.ok || !outcome.agentId) {
    return c.json({ error: outcome.error ?? 'unauthorized' }, (outcome.status ?? 401) as 400 | 401 | 503);
  }
  c.set('agentId', outcome.agentId);
  return next();
});

/**
 * Isolation probe — write a marker into THIS agent's container, then read it
 * back. Two agents writing different markers and never seeing each other's is a
 * live proof that containers are per-agent. Needs only the container (not
 * Hermes), so it works before/without a booted gateway.
 */
hosted.post('/hosted/agent/probe', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);
  const marker = `marker-for-${agentId}`;
  try {
    const result = await withRetry<{ stdout?: string }>(
      () => (container as any).exec(
        `mkdir -p /tmp/hw && printf %s ${JSON.stringify(marker)} > /tmp/hw/agent-marker; cat /tmp/hw/agent-marker`,
      ),
      { attempts: 3, timeoutMs: 60_000, label: `probe:${agentId}` },
    );
    const readback = (result?.stdout ?? '').trim();
    return c.json({
      ok: true,
      agentId,
      wrote: marker,
      read: readback,
      isolated: readback === marker, // false ⇒ this container saw a foreign marker
    });
  } catch (err) {
    return c.json({ ok: false, agentId, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/** Read the marker without writing — used to assert agent B never sees agent A's. */
hosted.get('/hosted/agent/probe', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);
  try {
    const result = await withRetry<{ stdout?: string }>(
      () => (container as any).exec('cat /tmp/hw/agent-marker 2>/dev/null || printf "(none)"'),
      { attempts: 3, timeoutMs: 30_000, label: `probe-read:${agentId}` },
    );
    return c.json({ ok: true, agentId, read: (result?.stdout ?? '').trim() });
  } catch (err) {
    return c.json({ ok: false, agentId, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/**
 * Boot check — start the gateway, then report the OS user the Hermes gateway
 * process actually runs as. Proves the v0.2 privilege drop: the gateway must run
 * as the unprivileged `hermes` user (via gosu), not root.
 */
hosted.get('/hosted/agent/boot-check', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);

  let gatewayToken: string;
  try {
    gatewayToken = requireGatewayToken(c.env);
  } catch (err) {
    return c.json({ error: 'server_misconfigured', message: err instanceof Error ? err.message : String(err) }, 503);
  }

  try {
    await withRetry(
      () => ensureGateway(container, {
        providerKeys: collectProviderKeys(c.env),
        gatewayToken,
        defaultModel: c.env.HERMES_DEFAULT_MODEL,
      }),
      { attempts: 3, timeoutMs: 300_000, label: `boot:${agentId}` },
    );
  } catch (err) {
    return c.json({ ok: false, agentId, error: 'container_not_ready', message: err instanceof Error ? err.message : String(err) }, 503);
  }

  const result = await withRetry<{ stdout?: string }>(
    () => (container as any).exec(
      "printf 'gateway_user=%s\\n' \"$(ps -o user= -p \"$(pgrep -f 'hermes gateway' | head -1)\" 2>/dev/null | tr -d ' ')\"",
    ),
    { attempts: 3, timeoutMs: 60_000, label: `boot-check:${agentId}` },
  );
  const out = (result?.stdout ?? '').trim();
  const gatewayUser = (out.match(/gateway_user=(\S+)/) || [])[1] ?? '';
  return c.json({
    ok: true,
    agentId,
    gatewayUser,
    nonRoot: gatewayUser !== '' && gatewayUser !== 'root', // true ⇒ gosu drop worked
    raw: out,
  });
});

/** Per-agent chat completions — same behavior as single-tenant, scoped by agent. */
hosted.post('/hosted/agent/v1/chat/completions', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);

  let gatewayToken: string;
  try {
    gatewayToken = requireGatewayToken(c.env);
  } catch (err) {
    return c.json({ error: 'server_misconfigured', message: err instanceof Error ? err.message : String(err) }, 503);
  }

  try {
    await withRetry(
      () => ensureGateway(container, {
        providerKeys: collectProviderKeys(c.env),
        gatewayToken,
        defaultModel: c.env.HERMES_DEFAULT_MODEL,
      }),
      { attempts: 3, timeoutMs: 300_000, label: `ensure:${agentId}` },
    );
  } catch (err) {
    return c.json({ error: 'container_not_ready', message: err instanceof Error ? err.message : String(err) }, 503);
  }

  const body = await c.req.text();
  const upstream = new Request(`http://localhost:${HERMES_API_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gatewayToken}` },
    body,
  });

  try {
    const response = await withRetry<Response>(
      () => (container as any).containerFetch(upstream, HERMES_API_PORT),
      { attempts: 2, timeoutMs: 300_000, isRetryable: () => false, label: `fetch:${agentId}` },
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (err) {
    return c.json({ error: 'gateway_error', message: err instanceof Error ? err.message : String(err) }, 502);
  }
});

export { hosted };
