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
import { collectProviderKeys, providerKeysWithByok, requireGatewayToken } from '../lib/container';
import {
  checkServiceAuth,
  getContainerForAgent,
  SERVICE_AGENT_HEADER,
} from '../lib/tenant';
import { withRetry } from '../lib/resilience';
import { ensureGateway, HERMES_API_PORT, killGateway, restartGateway } from '../services/container-lifecycle';
import { parseSlackApplyBody, buildSlackApplyShell } from '../lib/slack-platform';
import { parseAgentConfigBody, buildAgentConfigShell } from '../lib/agent-config';
import {
  LOG_SOURCES,
  MAX_LOG_CHARS,
  buildLogShell,
  clampLines,
  isLogSource,
  redactLog,
} from '../lib/agent-logs';
import { terminal } from './terminal';

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

/**
 * Stop an agent's gateway/dashboard processes. Called when Divinci deletes the
 * agent record so the container stops doing work and sleep-evicts promptly
 * (there is no external "delete a DO" — stopping the process is the teardown).
 */
hosted.post('/hosted/agent/stop', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);
  try {
    await withRetry(() => killGateway(container), {
      attempts: 2, timeoutMs: 60_000, isRetryable: () => false, label: `stop:${agentId}`,
    });
    return c.json({ ok: true, agentId, status: 'stopped' });
  } catch (err) {
    return c.json({ ok: false, agentId, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

/**
 * Full-surface per-agent proxy. Forwards ANY path under /hosted/agent/proxy/* to
 * the agent's container Hermes API (/v1/*, /api/sessions/*, /health, …) so an
 * external client — a local Hermes with GATEWAY_PROXY_URL, the desktop app, or
 * any OpenAI-compatible client — can drive the agent through Divinci's proxy.
 * Still service-authed (only Divinci's backend calls this) + scoped by agentId.
 */
hosted.all('/hosted/agent/proxy/*', async (c) => {
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
        providerKeys: providerKeysWithByok(
          c.env,
          c.req.header('x-hermes-provider'),
          c.req.header('x-hermes-provider-key'),
        ),
        gatewayToken,
        defaultModel: c.env.HERMES_DEFAULT_MODEL,
      }),
      { attempts: 3, timeoutMs: 300_000, label: `ensure:${agentId}` },
    );
  } catch (err) {
    return c.json({ error: 'container_not_ready', message: err instanceof Error ? err.message : String(err) }, 503);
  }

  const reqUrl = new URL(c.req.raw.url); // pathname already normalized by URL parsing
  const subPath = reqUrl.pathname.replace(/^\/hosted\/agent\/proxy/, '') || '/';
  // Defense-in-depth: refuse any residual traversal token before forwarding.
  for (const seg of subPath.split('/')) {
    let decoded = seg;
    try { decoded = decodeURIComponent(seg); } catch { return c.json({ error: 'bad_path' }, 400); }
    if (decoded === '..' || decoded === '.') return c.json({ error: 'bad_path' }, 400);
  }
  const target = `http://localhost:${HERMES_API_PORT}${subPath}${reqUrl.search}`;
  const method = c.req.raw.method;

  const headers = new Headers();
  const ct = c.req.header('content-type');
  if (ct) headers.set('content-type', ct);
  const accept = c.req.header('accept');
  if (accept) headers.set('accept', accept);
  // Pass a multi-user session key through if the client sent one.
  const sessionKey = c.req.header('x-hermes-session-key');
  if (sessionKey) headers.set('x-hermes-session-key', sessionKey);
  headers.set('authorization', `Bearer ${gatewayToken}`);

  const body = method === 'GET' || method === 'HEAD' ? undefined : await c.req.raw.arrayBuffer();
  const upstream = new Request(target, { method, headers, body });

  try {
    const response = await withRetry<Response>(
      () => (container as any).containerFetch(upstream, HERMES_API_PORT),
      { attempts: 2, timeoutMs: 300_000, isRetryable: () => false, label: `proxy:${agentId}` },
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
        providerKeys: providerKeysWithByok(
          c.env,
          c.req.header('x-hermes-provider'),
          c.req.header('x-hermes-provider-key'),
        ),
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

/**
 * Apply Slack Socket Mode config for this agent (private-channel ready).
 *
 * Called by Divinci public-api after saving encrypted tokens on the HermesAgent
 * record. Writes a durable `~/.hermes/divinci-platforms/slack.env` that
 * start-hermes.sh merges into Hermes' .env on every cold boot, then restarts
 * the gateway so the Socket Mode adapter connects with the new tokens.
 *
 * Body shape (HermesSlackApplyPayload from public-api):
 *   { enabled, botToken?, appToken?, allowedUsers, allowedChannels,
 *     freeResponseChannels, homeChannel?, homeChannelName?,
 *     replyInThread, requireMention }
 */
hosted.post('/hosted/agent/platforms/slack', async (c) => {
  const agentId = c.var.agentId;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'body must be JSON' }, 400);
  }

  const parsed = parseSlackApplyBody(raw);
  if (!parsed.ok) {
    return c.json({ error: 'invalid_body', message: parsed.error }, parsed.status);
  }

  const container = getContainerForAgent(c.env, agentId);

  let gatewayToken: string;
  try {
    gatewayToken = requireGatewayToken(c.env);
  } catch (err) {
    return c.json(
      { error: 'server_misconfigured', message: err instanceof Error ? err.message : String(err) },
      503,
    );
  }

  const shell = buildSlackApplyShell(parsed.body);
  try {
    const result = await withRetry<{ stdout?: string; stderr?: string; exitCode?: number }>(
      () => (container as any).exec(shell, { timeout: 60_000 }),
      { attempts: 2, timeoutMs: 90_000, label: `slack-write:${agentId}` },
    );
    if (result?.exitCode && result.exitCode !== 0) {
      return c.json(
        {
          ok: false,
          agentId,
          error: 'write_failed',
          message: (result.stderr || result.stdout || 'non-zero exit').toString().substring(0, 400),
        },
        502,
      );
    }
  } catch (err) {
    return c.json(
      {
        ok: false,
        agentId,
        error: 'write_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  // Restart gateway so Slack Socket Mode (re)connects with the new env.
  // ensureGateway / restartGateway inject platform+BYOK keys; Slack comes from
  // the durable file merged by start-hermes.sh.
  try {
    await withRetry(
      () =>
        restartGateway(container, {
          providerKeys: collectProviderKeys(c.env),
          gatewayToken,
          defaultModel: c.env.HERMES_DEFAULT_MODEL,
        }),
      { attempts: 2, timeoutMs: 300_000, label: `slack-restart:${agentId}` },
    );
  } catch (err) {
    // Config is on disk — report partial success so public-api can still mark
    // applied-with-warning rather than rolling back the Mongo record.
    return c.json(
      {
        ok: true,
        agentId,
        enabled: parsed.body.enabled,
        restarted: false,
        warning: err instanceof Error ? err.message : String(err),
      },
      200,
    );
  }

  return c.json({
    ok: true,
    agentId,
    enabled: parsed.body.enabled,
    restarted: true,
    // Never echo tokens back.
    hasBotToken: Boolean(parsed.body.botToken),
    hasAppToken: Boolean(parsed.body.appToken),
    allowedChannels: parsed.body.allowedChannels || '',
  });
});

/**
 * Apply per-agent identity (SOUL.md) and model pin into the container.
 *
 * Divinci calls this whenever an agent's systemPrompt or hermesModel changes.
 * Without it those two fields only affect chats routed through Divinci's own
 * API — Slack (and any other gateway platform) never sees them, because those
 * replies are composed by the container's Hermes gateway, not by us.
 *
 * Unlike the Slack route this does NOT restart the gateway: `hermes config set`
 * applies live, and SOUL.md is re-read per turn. A restart would drop active
 * Socket Mode conversations to change a persona, which is a bad trade.
 */
hosted.post('/hosted/agent/config', async (c) => {
  const agentId = c.var.agentId;
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'invalid_json', message: 'body must be JSON' }, 400);
  }

  const parsed = parseAgentConfigBody(raw);
  if (!parsed.ok) {
    return c.json({ error: 'invalid_body', message: parsed.error }, parsed.status);
  }

  const container = getContainerForAgent(c.env, agentId);
  try {
    requireGatewayToken(c.env);
  } catch (err) {
    return c.json(
      { error: 'server_misconfigured', message: err instanceof Error ? err.message : String(err) },
      503,
    );
  }

  const shell = buildAgentConfigShell(parsed.body);
  try {
    const result = await withRetry<{ stdout?: string; stderr?: string; exitCode?: number }>(
      () => (container as any).exec(shell, { timeout: 60_000 }),
      { attempts: 2, timeoutMs: 90_000, label: `agent-config:${agentId}` },
    );
    if (result?.exitCode && result.exitCode !== 0) {
      return c.json(
        {
          ok: false,
          agentId,
          error: 'write_failed',
          message: (result.stderr || result.stdout || 'non-zero exit').toString().substring(0, 400),
        },
        502,
      );
    }
    return c.json({ ok: true, agentId, stdout: (result?.stdout || '').toString().substring(0, 400) }, 200);
  } catch (err) {
    return c.json(
      { ok: false, agentId, error: 'write_failed', message: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Read the tail of an agent container's log.
 *
 * Uses the raw container exec rather than Hermes' own `logs` route, which sits
 * on the `instance` API behind ADMIN_TOKEN/API_TOKEN — secrets these Workers do
 * not have. This therefore works when the gateway is down, which is when a log
 * is worth reading. Output is redacted for secret-shaped values before it
 * leaves the Worker.
 *
 *   GET /hosted/agent/logs?source=gateway|dashboard&lines=200
 */
hosted.get('/hosted/agent/logs', async (c) => {
  const agentId = c.var.agentId;

  const rawSource = c.req.query('source') ?? 'gateway';
  if (!isLogSource(rawSource)) {
    return c.json(
      {
        error: 'invalid_source',
        message: `source must be one of: ${Object.keys(LOG_SOURCES).join(', ')}`,
      },
      400,
    );
  }
  const lines = clampLines(c.req.query('lines'));

  const container = getContainerForAgent(c.env, agentId);
  try {
    const result = await withRetry<{ stdout?: string; stderr?: string; exitCode?: number }>(
      () => (container as any).exec(buildLogShell(rawSource, lines), { timeout: 30_000 }),
      { attempts: 2, timeoutMs: 60_000, label: `logs:${agentId}` },
    );
    // stdout and stderr are BOTH surfaced. The container's own scripts split
    // their output across the two (setup-terminal.sh logs to stdout but writes
    // its FATAL to stderr), and reporting only one is how a fatal error becomes
    // invisible — the exact failure this route exists to end.
    const stdout = redactLog((result?.stdout ?? '').toString().slice(0, MAX_LOG_CHARS));
    const stderr = redactLog((result?.stderr ?? '').toString().slice(0, MAX_LOG_CHARS));
    return c.json({
      ok: true,
      agentId,
      source: rawSource,
      path: LOG_SOURCES[rawSource],
      lines,
      exitCode: result?.exitCode ?? 0,
      redactions: stdout.redactions + stderr.redactions,
      log: stdout.text,
      stderr: stderr.text,
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        agentId,
        error: 'log_read_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

/**
 * Virtual-terminal routes are mounted INTO this app rather than registered
 * separately on the root app, so they inherit the `/hosted/*` service-auth
 * middleware above (and its validated agentId) instead of needing a second,
 * independently-maintained copy of the gate. A terminal reachable without
 * service auth would be a remote code-execution endpoint on the open internet.
 */
hosted.route('/', terminal);

export { hosted };
