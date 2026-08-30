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
import { resolveTurnTimeoutMs } from '../lib/turn-timeout';
import { ensureGateway, HERMES_API_PORT, killGateway, restartGateway } from '../services/container-lifecycle';
import { parseSlackApplyBody, buildSlackApplyShell } from '../lib/slack-platform';
import { BOOT_CHECK_COMMAND, parseBootCheck } from '../lib/boot-check';
import { parseAgentConfigBody, buildAgentConfigShell } from '../lib/agent-config';
import {
  LOG_SOURCES,
  MAX_LOG_CHARS,
  buildLogShell,
  clampLines,
  isLogSource,
  redactLog,
} from '../lib/agent-logs';
import { NET_DIAG_COMMAND } from '../lib/net-diag';
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
    () => (container as any).exec(BOOT_CHECK_COMMAND),
    { attempts: 3, timeoutMs: 60_000, label: `boot-check:${agentId}` },
  );
  const facts = parseBootCheck(result?.stdout);
  return c.json({
    ok: true,
    agentId,
    gatewayUser: facts.gatewayUser,
    nonRoot: facts.nonRoot,
    slackEnvPresent: facts.slackEnvPresent,
    raw: (result?.stdout ?? '').trim(),
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
 * Destroy the container INSTANCE so the next boot pulls the current image.
 *
 * ⚠️ WHY `stop` IS NOT ENOUGH, AND WHY THIS ROUTE HAD TO EXIST.
 *
 * `/hosted/agent/stop` calls `killGateway`, which kills the Hermes PROCESS
 * inside the container. The container instance — and its filesystem, from
 * whatever image it was created with — survives. So `stop` + `boot-check`
 * re-runs the OLD `/usr/local/bin/start-hermes.sh` from the OLD image.
 *
 * ⚠️ CORRECTED 2026-08-25 — THIS PARAGRAPH SAID THE OPPOSITE AND IT IS WRONG.
 *
 * It read: "Env-var changes still apply on that path (they are injected at
 * process start by `ensureGateway`, never baked in)". MEASURED, and they do
 * NOT. After a Worker secret was rewritten, a `stop`-restarted container wrote
 * `.env` with 11 lines from the OLD value and kept 401ing; an EVICTed one wrote
 * 5 lines and had the new one. `stop` kills the gateway PROCESS and reuses the
 * container's cached environment — only `container.destroy()` re-reads Worker
 * env.
 *
 * So: ANY Worker secret or var change needs an EVICT, not a stop.
 *
 * This cost real time on 2026-08-25. Both the "is the file that READS the var
 * new?" heuristic and this docstring pointed at `stop`, and a stop was used to
 * pick up a rewritten HERMES_DEFAULT_MODEL. It could not have worked, and
 * nothing said so — the boot log looked normal because the model was coming
 * from the per-agent pin file, not from the secret.
 *
 * The genuinely confusing part the original was reaching for is still true and
 * still worth knowing: an IMAGE change made in the same deploy also does not
 * land on a stop. The difference is that neither half does.
 *
 * Observed 2026-08-14: a deploy carrying a new Dockerfile layer and a modified
 * start-hermes.sh reported success, `wrangler` logged `SUCCESS Modified
 * application … image = sha256:<new>`, a stop+boot-check ran cleanly — and the
 * boot log contained NONE of the new script's output. The container was still
 * the old image.
 *
 * ⚠️ AND IT WOULD NEVER HAVE FIXED ITSELF. A container is replaced when it
 * sleeps and is re-created. `sleepAfter` is 30m on this Worker (it MUST exceed
 * the keepalive interval, or every probe churns the container and spams the
 * customer's Slack — see hermesContainer.ts). Divinci's keepalive probes every
 * 10 MINUTES, and every probe calls `renewActivityTimeout()`. A warm
 * socket-mode container therefore never sleeps, is never replaced, and can
 * never pick up a new image. The setting that keeps Slack stable is in direct
 * tension with image delivery, and nothing surfaced that tension: the deploy
 * is green either way.
 *
 * This route is the release valve. It is deliberately separate from `stop`
 * rather than folded into it — destroying the instance loses in-container
 * state (session DBs, the Slack platform config the sweep pushes) and forces a
 * cold start, so it should be an explicit act, not a side effect of a restart.
 */
hosted.post('/hosted/agent/evict', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);
  try {
    // Stop the gateway first so Hermes can flush state to disk before the
    // instance goes away. Best-effort: a gateway that is already dead (or
    // wedged) must not block the eviction, which is the whole point of
    // reaching for this route.
    try {
      await killGateway(container);
    } catch {
      /* already gone, or unresponsive — proceed to destroy regardless */
    }
    await (container as any).destroy();
    return c.json({ ok: true, agentId, status: 'evicted' });
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
  //
  // ⛔ EXCEPT our own reserved namespace. This header is forwarded VERBATIM
  // from the customer's request (`/api/v1/hermes-proxy/*` reads it straight
  // off `req.headers`), and the container's guard grants a wider toolset to
  // one value in that namespace. Without this refusal, any customer holding
  // a proxy API key could set it and hand themselves the bounded terminal on
  // an unattended turn.
  //
  // REFUSE rather than strip: silently dropping it would let a caller
  // believe their session scoping applied when it did not, and a 400 says
  // which header is at fault. Nothing legitimate needs this prefix — it is
  // minted by the internal chat route, never sent by a client.
  const sessionKey = c.req.header('x-hermes-session-key');
  if (isReservedSessionKey(sessionKey)) {
    return c.json(
      {
        error: 'reserved_session_key',
        message: `X-Hermes-Session-Key must not begin with "${DIVINCI_INTERNAL_SESSION_PREFIX}" — that namespace is reserved.`,
      },
      400,
    );
  }
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
/**
 * Session-key namespace reserved for Divinci's own internal trust signals.
 *
 * The container's `divinci_email_guard` plugin widens an unattended turn's
 * toolset when it sees `divinci-internal-proactive` — so whether a value in
 * this namespace can reach the container IS the security boundary.
 *
 * ⚠️ It is NOT a secret and must never become one. `X-Hermes-Session-Key` is
 * echoed in logs and used for memory scoping; a guessable value is fine
 * PROVIDED no customer-facing path can set it. That is what the two rules
 * below enforce, and neither is sufficient alone:
 *
 *   1. the proxy route REFUSES this namespace from the caller (it forwards
 *      the header verbatim, so without this any customer holding a
 *      `/api/v1/hermes-proxy` key could mint the signal themselves);
 *   2. this route MINTS it, and only from `X-Divinci-Trigger`, which arrives
 *      behind the service-secret auth every /hosted route already requires.
 */
const DIVINCI_INTERNAL_SESSION_PREFIX = 'divinci-internal-';
const PROACTIVE_SESSION_KEY = 'divinci-internal-proactive';

/** True when a caller-supplied session key is trying to enter our namespace. */
export function isReservedSessionKey(raw: string | undefined | null): boolean {
  return (raw ?? '').trim().toLowerCase().startsWith(DIVINCI_INTERNAL_SESSION_PREFIX);
}

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

  // Divinci's public-api declares WHY this turn is running. Only 'proactive'
  // — its own scheduled wake, whose prompt it built from its own transcript
  // — earns the widened toolset; inbound email and Slack send nothing and
  // therefore stay on the narrow set by omission rather than by check.
  //
  // ⚠️ Derived from the header, never forwarded from one. A caller cannot
  // hand us a session key here: we mint the value ourselves, so the only
  // thing the caller controls is a trigger name we compare against one
  // literal. Any unrecognised trigger yields no session key at all.
  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${gatewayToken}`,
  };
  const toolsDisabled = ['1', 'true', 'yes'].includes(
    (c.env.HERMES_PROACTIVE_TOOLS_DISABLED ?? '').trim().toLowerCase(),
  );
  if (
    !toolsDisabled &&
    (c.req.header('x-divinci-trigger') ?? '').trim().toLowerCase() === 'proactive'
  ) {
    upstreamHeaders['X-Hermes-Session-Key'] = PROACTIVE_SESSION_KEY;
  }

  const upstream = new Request(`http://localhost:${HERMES_API_PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: upstreamHeaders,
    body,
  });

  try {
    const response = await withRetry<Response>(
      () => (container as any).containerFetch(upstream, HERMES_API_PORT),
      {
        // `attempts: 1`, stated rather than implied. This read `attempts: 2`
        // with `isRetryable: () => false`, which can never take the second
        // attempt — dead config that read as a retry policy. A wake is
        // METERED and its tools have side effects, so one attempt is also
        // the correct policy: replaying a turn that may already have posted
        // to Slack or written a task is worse than failing it.
        attempts: 1,
        timeoutMs: resolveTurnTimeoutMs(c.env.HERMES_TURN_TIMEOUT_MS),
        isRetryable: () => false,
        label: `fetch:${agentId}`,
      },
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
 * Network-boundary diagnostic. Runs a FIXED probe battery (no caller input) as
 * root in the container, to work out why the terminal's egress lockdown does
 * not hold in the hosted sandbox. See lib/net-diag.ts for why this exists as a
 * separate surface rather than being debugged through the terminal itself.
 */
hosted.get('/hosted/agent/net-diag', async (c) => {
  const agentId = c.var.agentId;
  const container = getContainerForAgent(c.env, agentId);
  try {
    const result = await withRetry<{ stdout?: string; stderr?: string; exitCode?: number }>(
      () => (container as any).exec(NET_DIAG_COMMAND, { timeout: 60_000 }),
      { attempts: 1, timeoutMs: 90_000, isRetryable: () => false, label: `net-diag:${agentId}` },
    );
    const stdout = redactLog((result?.stdout ?? '').toString().slice(0, MAX_LOG_CHARS));
    const stderr = redactLog((result?.stderr ?? '').toString().slice(0, MAX_LOG_CHARS));
    return c.json({
      ok: true,
      agentId,
      exitCode: result?.exitCode ?? 0,
      out: stdout.text,
      stderr: stderr.text,
    });
  } catch (err) {
    return c.json(
      { ok: false, agentId, error: 'net_diag_failed', message: err instanceof Error ? err.message : String(err) },
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


// ── Fleet claim leases ───────────────────────────────────────────────────────
//
// The enforced half of "don't dogpile". Today the fleet divides work by being
// ASKED to in a prompt ("say which lever you are taking"), which is not
// turn-taking; the only enforced control is shadow mode, which mutes an agent
// rather than sequencing it.
//
// Scoped by fleet, NOT by agent: the point is that agents in the same fleet
// contend with each other, so the DO id is the fleet id. `X-Divinci-Fleet-Id`
// is supplied by the service-authenticated caller (public-api) alongside the
// agent header the rest of this file uses; an agent cannot choose its own
// fleet, or it could trivially escape contention by claiming in a private one.
const FLEET_HEADER = 'x-divinci-fleet-id';

type FleetStub =
  | { ok: true; stub: DurableObjectStub }
  | { ok: false; status: 400 | 501; error: string };

function fleetStub(c: { env: Env; req: { header: (n: string) => string | undefined } }): FleetStub {
  const ns = c.env.FLEET;
  if (!ns) {
    return { ok: false, status: 501, error: 'fleet coordinator not configured on this deployment' };
  }
  const fleetId = c.req.header(FLEET_HEADER);
  // Constrained because it names a DO; an unvalidated id is a way to address
  // an arbitrary object.
  if (!fleetId || !/^[A-Za-z0-9_-]{1,128}$/.test(fleetId)) {
    return { ok: false, status: 400, error: `missing or invalid ${FLEET_HEADER}` };
  }
  return { ok: true, stub: ns.get(ns.idFromName(`fleet:${fleetId}`)) };
}

hosted.get('/hosted/fleet/claims', async (c) => {
  const f = fleetStub(c);
  if (!f.ok) return c.json({ ok: false, error: f.error }, f.status);
  return f.stub.fetch(new Request('https://do/claims', { method: 'GET' }));
});

for (const op of ['acquire', 'release'] as const) {
  hosted.post(`/hosted/fleet/claims/${op}`, async (c) => {
    const f = fleetStub(c);
    if (!f.ok) return c.json({ ok: false, error: f.error }, f.status);
    // The agent identity is taken from the service-auth gate, never from the
    // body: a self-declared holder lets any agent claim or release as another,
    // which is the same as having no ledger.
    let body: Record<string, unknown> = {};
    try { body = await c.req.json(); } catch { /* empty body is valid for release-less ops */ }
    body.holder = c.get('agentId');
    return f.stub.fetch(new Request(`https://do/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
  });
}

export { hosted };
