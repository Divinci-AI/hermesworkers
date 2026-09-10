/**
 * Container lifecycle helpers for the Hermes Sandbox container.
 *
 * Every container interaction goes through the Sandbox SDK methods
 * (`startProcess`, `listProcesses`, `exec`, `containerFetch`) — there
 * is no business logic inside the DO class itself.
 *
 * This mirrors the pattern documented by Cloudflare's moltworker reference
 * implementation: keep the DO class minimal, treat it like a remote shell.
 */

const STARTUP_SCRIPT = '/usr/local/bin/start-hermes.sh';
const API_PORT = 18789;
const DASHBOARD_PORT = 9119;

// The container can take a few minutes to wake up from sleep on `standard-1`.
// Allow generous headroom so first-request after sleep doesn't time out.
const STARTUP_TIMEOUT_MS = 300_000;

export const HERMES_API_PORT = API_PORT;
export const HERMES_DASHBOARD_PORT = DASHBOARD_PORT;

// ─── Port probes ────────────────────────────────────────────────────

/**
 * Returns true if `localhost:<port>` is accepting TCP connections inside
 * the container. Uses bash's built-in `/dev/tcp` (no external binary needed)
 * with a netcat fallback for older base images.
 */
export async function isPortOpen(
  container: DurableObjectStub,
  port: number = API_PORT,
): Promise<boolean> {
  try {
    const result = await (container as any).exec(
      `bash -c 'timeout 1 bash -c "</dev/tcp/localhost/${port}" 2>/dev/null' || nc -z localhost ${port} 2>/dev/null`,
    );
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// ─── Process management ────────────────────────────────────────────

/**
 * Locate the running `hermes gateway` process tracked by the Sandbox SDK.
 * Returns null when no matching process exists.
 */
async function findGatewayProcess(container: DurableObjectStub): Promise<any | null> {
  try {
    const processes = await (container as any).listProcesses();
    for (const proc of processes) {
      const cmd: string = proc.command || '';
      const isGateway =
        cmd.includes('start-hermes.sh') || cmd.includes('hermes gateway');
      if (isGateway && (proc.status === 'running' || proc.status === 'starting')) {
        return proc;
      }
    }
  } catch (e) {
    console.warn('[container-lifecycle] listProcesses failed:', e);
  }
  return null;
}

/**
 * Kill any running Hermes gateway process and clean up its lock files.
 *
 * Hermes forks worker processes that don't always die with the tracked PID,
 * so we hit them with both SIGTERM (graceful, lets state persist to disk)
 * and SIGKILL via `pgrep`/`pkill` for anything still listening on the port.
 *
 * Then sweep orphaned `divinci_terminal` MCP children — see the comment on the
 * sweep below for why the gateway's own teardown cannot be relied on here.
 *
 * `sleep` is injectable so tests do not sit through the real grace periods.
 */
export async function killGateway(
  container: DurableObjectStub,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  // Graceful shutdown
  try {
    await (container as any).exec(
      [
        'kill -TERM $(pgrep -f "hermes gateway" 2>/dev/null) 2>/dev/null',
        'kill -TERM $(pgrep -f "hermes dashboard" 2>/dev/null) 2>/dev/null',
        'true',
      ].join('; '),
    );
  } catch {
    /* process may already be gone */
  }
  await sleep(3000);

  // Force kill anything still listening on our ports
  try {
    await (container as any).exec(
      [
        'kill -9 $(pgrep -f "hermes gateway" 2>/dev/null) 2>/dev/null',
        'kill -9 $(pgrep -f "hermes dashboard" 2>/dev/null) 2>/dev/null',
        `kill -9 $(ss -tlnp sport = :${API_PORT} 2>/dev/null | grep -oP "pid=\\K[0-9]+") 2>/dev/null`,
        `kill -9 $(ss -tlnp sport = :${DASHBOARD_PORT} 2>/dev/null | grep -oP "pid=\\K[0-9]+") 2>/dev/null`,
        'true',
      ].join('; '),
    );
  } catch {
    /* process may already be gone */
  }

  // Also kill via the tracked-process API in case it's still registered.
  const proc = await findGatewayProcess(container);
  if (proc) {
    try {
      await proc.kill();
    } catch {
      /* may already be dead */
    }
  }

  // Sweep orphaned divinci_terminal MCP children, now that the gateway that
  // owned them is gone.
  //
  // Hermes reaps its own stdio MCP subprocesses on a GRACEFUL exit
  // (MCPServerTask.shutdown / _kill_orphaned_mcp_children). Its startup sweep
  // cannot help after a hard exit: the orphan registry those functions read is
  // in-process state, so SIGKILL takes the list of what to reap along with the
  // process holding it. Every SIGKILL above therefore leaves a live
  // mcp-terminal-server behind, and each restart adds one — four were counted
  // in a live container on 2026-08-23, alongside a divinci_terminal that had
  // gone unreachable on two agents at once and later recovered on its own.
  //
  // The gateway is dead by this point, so nothing legitimately holds one; a
  // fresh gateway spawns its own.
  try {
    await (container as any).exec(
      [
        'kill -9 $(pgrep -f "mcp-terminal-server.js" 2>/dev/null) 2>/dev/null',
        'true',
      ].join('; '),
    );
  } catch {
    /* nothing to reap */
  }

  await sleep(1000);
}

// ─── Boot ──────────────────────────────────────────────────────────

/**
 * Ensure the Hermes gateway is running. If no process is found, start a fresh
 * one with the supplied environment variables and wait for the API port to
 * become reachable.
 *
 * `providerKeys` carries the user's BYOK secrets (Anthropic / OpenRouter /
 * OpenAI). They are written to ~/.hermes/.env by the startup script.
 */
export async function ensureGateway(
  container: DurableObjectStub,
  options: {
    providerKeys: Record<string, string>;
    gatewayToken?: string;
    defaultModel?: string;
  },
): Promise<void> {
  // Fast path: existing process is reachable.
  const existing = await findGatewayProcess(container);
  if (existing) {
    try {
      await existing.waitForPort(API_PORT, {
        mode: 'tcp',
        timeout: STARTUP_TIMEOUT_MS,
      });
      return;
    } catch {
      // Process exists but the port isn't open — recycle and try again.
      await killGateway(container);
    }
  }

  // Safety net: the port may already be open even if listProcesses missed it.
  if (await isPortOpen(container, API_PORT)) return;

  // Cold start: launch the script with the latest BYOK secrets injected.
  const envVars: Record<string, string> = { ...options.providerKeys };
  if (options.gatewayToken) envVars.HERMES_GATEWAY_TOKEN = options.gatewayToken;
  if (options.defaultModel) envVars.HERMES_DEFAULT_MODEL = options.defaultModel;

  let proc: any;
  try {
    proc = await (container as any).startProcess(STARTUP_SCRIPT, {
      env: envVars,
      autoCleanup: false,
    });
  } catch (err) {
    throw new Error(
      `Failed to start Hermes gateway: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    await proc.waitForPort(API_PORT, {
      mode: 'tcp',
      timeout: STARTUP_TIMEOUT_MS,
    });
  } catch {
    try {
      const logs = await proc.getLogs();
      throw new Error(
        `Hermes gateway failed to start within ${STARTUP_TIMEOUT_MS / 1000}s. stderr: ${logs.stderr || '(empty)'}`,
      );
    } catch (logErr) {
      if (logErr instanceof Error && logErr.message.includes('failed to start'))
        throw logErr;
      throw new Error(
        `Hermes gateway failed to start within ${STARTUP_TIMEOUT_MS / 1000}s (logs unavailable)`,
      );
    }
  }
}

// ─── Status ────────────────────────────────────────────────────────

export async function getGatewayStatus(
  container: DurableObjectStub,
): Promise<'running' | 'starting' | 'stopped'> {
  const proc = await findGatewayProcess(container);
  if (!proc) {
    if (await isPortOpen(container, API_PORT)) return 'running';
    return 'stopped';
  }
  return proc.status === 'running' ? 'running' : 'starting';
}

// ─── Restart ───────────────────────────────────────────────────────

export async function restartGateway(
  container: DurableObjectStub,
  options: {
    providerKeys: Record<string, string>;
    gatewayToken?: string;
    defaultModel?: string;
  },
): Promise<void> {
  await killGateway(container);
  await ensureGateway(container, options);
}
