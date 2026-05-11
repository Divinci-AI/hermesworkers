import { Hono } from 'hono';
import {
  getContainer,
  collectProviderKeys,
  type Env,
} from '../lib/container';
import {
  ensureGateway,
  getGatewayStatus,
  killGateway,
  restartGateway,
} from '../services/container-lifecycle';

const instance = new Hono<{ Bindings: Env }>();

/**
 * Liveness probe — confirms the Worker is up and reports whether the
 * Hermes gateway is reachable inside the container.
 */
instance.get('/api/health', async (c) => {
  const container = getContainer(c.env);
  let status: string;
  try {
    status = await getGatewayStatus(container);
  } catch {
    status = 'unknown';
  }
  return c.json({ ok: true, gateway: status });
});

/**
 * Boot (or wake) the container without sending a chat message.
 * Useful as a warm-up call when you know a user is about to start chatting.
 */
instance.post('/api/instance/wake', async (c) => {
  const container = getContainer(c.env);
  try {
    await ensureGateway(container, {
      providerKeys: collectProviderKeys(c.env),
      gatewayToken: c.env.HERMES_GATEWAY_TOKEN,
      defaultModel: c.env.HERMES_DEFAULT_MODEL,
    });
    return c.json({ ok: true, status: 'ready' });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
});

/**
 * Hard-restart the container: kill PID 1 so Cloudflare respawns it from the
 * latest image. Returns immediately — the next request will trigger a fresh boot.
 */
instance.post('/api/instance/restart', async (c) => {
  const container = getContainer(c.env);
  try {
    await (container as any).exec('kill -9 1 2>/dev/null; true');
  } catch {
    // Expected: the exec connection drops when PID 1 dies.
  }
  return c.json({
    ok: true,
    status: 'restart_requested',
    note: 'next request will spawn a fresh container from the latest image',
  });
});

/**
 * Gracefully restart only the Hermes gateway (without killing the container).
 * Useful after rotating provider keys via `wrangler secret put`.
 */
instance.post('/api/instance/restart-gateway', async (c) => {
  const container = getContainer(c.env);
  try {
    await restartGateway(container, {
      providerKeys: collectProviderKeys(c.env),
      gatewayToken: c.env.HERMES_GATEWAY_TOKEN,
      defaultModel: c.env.HERMES_DEFAULT_MODEL,
    });
    return c.json({ ok: true, status: 'ready' });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }
});

/**
 * Stop the Hermes gateway and dashboard processes. The container itself stays
 * alive and will go to sleep on schedule.
 */
instance.post('/api/instance/stop', async (c) => {
  const container = getContainer(c.env);
  await killGateway(container);
  return c.json({ ok: true, status: 'stopped' });
});

/**
 * Debug endpoint: dump process list, listening ports, Hermes config and the
 * tail of the gateway log file. Handy when diagnosing a stuck container.
 */
instance.get('/api/instance/logs', async (c) => {
  const container = getContainer(c.env);
  const cmd = [
    'echo "=== HERMES STATUS ==="',
    'hermes status 2>&1 | head -60 || true',
    'echo "=== HERMES CONFIG ==="',
    'hermes config show 2>&1 | head -80 || true',
    'echo "=== ~/.hermes/.env ==="',
    'cat ~/.hermes/.env 2>/dev/null | sed "s/\\(.*=\\).\\{6,\\}/\\1<redacted>/" || true',
    'echo "=== SERVER LOG (tail 80) ==="',
    'tail -80 /tmp/hermes-server.log 2>/dev/null || echo "(no log yet)"',
    'echo "=== DASHBOARD LOG (tail 40) ==="',
    'tail -40 /tmp/hermes-dashboard.log 2>/dev/null || echo "(no dashboard log yet)"',
    'echo "=== PROCESS LIST ==="',
    'ps -ef 2>&1 | head -40',
    'echo "=== LISTENING PORTS ==="',
    'ss -tlnp 2>&1 || netstat -tln 2>&1 || true',
  ].join('; ');

  try {
    const result = await (container as any).exec(cmd);
    return c.json({
      ok: true,
      exitCode: result?.exitCode ?? null,
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
});

export { instance };
