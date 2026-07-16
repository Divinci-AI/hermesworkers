import { Hono } from 'hono';
import {
  getContainer,
  collectProviderKeys,
  requireGatewayToken,
  GatewayTokenMissingError,
  type Env,
} from '../lib/container';
import { authMiddleware, rateLimitMiddleware } from '../lib/auth';
import {
  ensureGateway,
  getGatewayStatus,
  killGateway,
  restartGateway,
} from '../services/container-lifecycle';

const instance = new Hono<{ Bindings: Env }>();

// Destructive / introspective control routes require the admin privilege level
// on top of the baseline chat gate applied in index.ts. A chat-token holder can
// wake and chat, but cannot restart, stop, or read logs. Admin routes are also
// rate-limited on their own (tighter) bucket.
const adminOnly = ['/api/instance/restart', '/api/instance/restart-gateway', '/api/instance/stop', '/api/instance/logs'];
for (const path of adminOnly) {
  instance.use(path, rateLimitMiddleware('admin'), authMiddleware('admin'));
}

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
      gatewayToken: requireGatewayToken(c.env),
      defaultModel: c.env.HERMES_DEFAULT_MODEL,
    });
    return c.json({ ok: true, status: 'ready' });
  } catch (err) {
    return c.json(
      {
        ok: false,
        error: err instanceof GatewayTokenMissingError ? 'server_misconfigured' : 'container_not_ready',
        message: err instanceof Error ? err.message : String(err),
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
      gatewayToken: requireGatewayToken(c.env),
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
    // Redact anything that looks like a key/token/secret/password before it
    // reaches the response (Hermes prints API_SERVER_KEY here otherwise).
    'hermes config show 2>&1 | sed -E "s/((KEY|TOKEN|SECRET|PASSWORD)[^=:]*[=:][[:space:]]*).*/\\1<redacted>/I" | head -80 || true',
    // Env keys only — never their values. Prints the variable NAMES present in
    // ~/.hermes/.env so an operator can confirm which secrets are wired, with
    // zero risk of leaking a short (<6 char) value the old redaction missed.
    'echo "=== ~/.hermes/.env (keys present, values withheld) ==="',
    'grep -oE "^[A-Za-z_][A-Za-z0-9_]*" ~/.hermes/.env 2>/dev/null || echo "(no .env yet)"',
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
