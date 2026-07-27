/**
 * Virtual-terminal routes (hosted, multi-tenant).
 *
 * Mounted under /hosted/agent/terminal/* behind the same service-auth gate as
 * the rest of the hosted surface: only Divinci's public-api calls these, always
 * scoped to one agent's container via the trusted X-Divinci-Agent-Id header.
 *
 * ON SHELL COMMANDS: these routes deliberately execute caller-supplied command
 * strings through a shell. That is the product — an agent that can only run a
 * fixed set of binaries is not a terminal. Command-string filtering is not the
 * control here and would give false assurance; the controls are structural and
 * enforced by the OS (unprivileged uid that cannot read credentials, empty
 * environment, iptables-enforced egress allowlist, workspace path confinement).
 * Every value this module interpolates into a shell string goes through
 * `shellQuote`, and `ensureTerminalBoundary` fails the request closed if the OS
 * boundary is not verifiably in place.
 */

import { Hono } from 'hono';
import type { Env } from '../lib/container';
import { getContainerForAgent } from '../lib/tenant';
import { withRetry } from '../lib/resilience';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  MAX_OUTPUT_CHARS,
  TerminalBoundaryError,
  WORKSPACE_ROOT,
  buildTerminalCommand,
  ensureTerminalBoundary,
  resolveWorkspacePath,
  shellQuote,
  truncateOutput,
  buildWorkspaceCommand,
  validateWorkspaceArgs,
  WORKSPACE_EGRESS_HOSTS,
} from '../lib/terminal';

type TerminalCtx = { Bindings: Env; Variables: { agentId: string } };

const terminal = new Hono<TerminalCtx>();

/** Per-command wall clock. Bounded so one command can't pin a container. */
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

interface ExecLike {
  exec(command: string, options?: Record<string, unknown>): Promise<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
}

function allowlistFor(env: Env): string {
  const base = (env as unknown as { EGRESS_ALLOWED_HOSTS?: string }).EGRESS_ALLOWED_HOSTS
    || DEFAULT_EGRESS_ALLOWLIST;
  // Google API hosts are added for the whole container, and only when the
  // Workspace feature is enabled — see WORKSPACE_EGRESS_HOSTS for why this
  // cannot honestly be scoped to a single command.
  return env.HERMES_WORKSPACE_CLI_ENABLED === 'true' ? `${base},${WORKSPACE_EGRESS_HOSTS}` : base;
}

/**
 * Establish the boundary, then run a command inside it. Any boundary failure is
 * a 503 and the command is NEVER run — see the fail-closed note in lib/terminal.
 */
async function runInBoundary(
  env: Env,
  agentId: string,
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; truncated: boolean }> {
  const container = getContainerForAgent(env, agentId);
  await ensureTerminalBoundary(container, agentId, allowlistFor(env));

  const timeout = Math.min(Math.max(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  const wrapped = buildTerminalCommand(command, opts.cwd);

  const result = await withRetry<{ stdout?: string; stderr?: string; exitCode?: number }>(
    () => (container as unknown as ExecLike).exec(wrapped, { timeout }),
    // A command with side effects must NOT be retried — re-running `npm publish`
    // or a migration because the first attempt looked flaky is worse than a
    // clean failure the agent can decide about.
    { attempts: 1, timeoutMs: timeout + 15_000, isRetryable: () => false, label: `term:${agentId}` },
  );

  const out = truncateOutput(result.stdout);
  const err = truncateOutput(result.stderr);
  return {
    stdout: out.text,
    stderr: err.text,
    exitCode: result.exitCode ?? 0,
    truncated: out.truncated || err.truncated,
  };
}

function boundaryFailure(c: { json: (b: unknown, s?: number) => Response }, err: unknown): Response {
  if (err instanceof TerminalBoundaryError) {
    return c.json(
      { error: 'terminal_unavailable', message: err.message },
      // 503: the container cannot safely host a terminal right now. Explicitly
      // not a 500 — this is a refusal, not a crash, and it is retryable.
      503,
    ) as Response;
  }
  return c.json(
    { error: 'terminal_error', message: err instanceof Error ? err.message : String(err) },
    502,
  ) as Response;
}

// ── exec ───────────────────────────────────────────────────────────────────
terminal.post('/hosted/agent/terminal/exec', async (c) => {
  const agentId = c.var.agentId;
  let body: { command?: string; cwd?: string; timeoutMs?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
  }
  const command = (body.command ?? '').trim();
  if (!command) return c.json({ error: 'bad_request', message: 'command is required' }, 400);
  if (command.length > 20_000) {
    return c.json({ error: 'bad_request', message: 'command is too long (max 20000 chars)' }, 400);
  }

  try {
    const result = await runInBoundary(c.env, agentId, command, {
      cwd: body.cwd,
      timeoutMs: body.timeoutMs,
    });
    return c.json({ ok: true, agentId, ...result, maxOutputChars: MAX_OUTPUT_CHARS });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

// ── git clone ──────────────────────────────────────────────────────────────
/**
 * NOTE: this deliberately does NOT use the Sandbox SDK's `gitCheckout()`.
 * That helper runs the clone from the container's default (root) context, which
 * would bypass every layer of the boundary — the unprivileged uid, the scrubbed
 * environment, and the iptables owner-match rules that force egress through the
 * allowlisting guard. Running `git` ourselves inside the boundary is the whole
 * point: a clone is exactly the operation most likely to fetch hostile content.
 */
terminal.post('/hosted/agent/terminal/git-clone', async (c) => {
  const agentId = c.var.agentId;
  let body: { repoUrl?: string; branch?: string; targetDir?: string; depth?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
  }

  const repoUrl = (body.repoUrl ?? '').trim();
  if (!repoUrl) return c.json({ error: 'bad_request', message: 'repoUrl is required' }, 400);

  // Scheme check: https only. `git://` and `ssh://` are unauthenticated or
  // key-bearing respectively, and `file://` would read the container's own
  // filesystem through git. The egress guard independently enforces the host
  // allowlist, so this is shape validation, not the security control.
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    return c.json({ error: 'bad_request', message: 'repoUrl must be a valid URL' }, 400);
  }
  if (parsed.protocol !== 'https:') {
    return c.json(
      { error: 'bad_request', message: 'repoUrl must be https:// (git://, ssh:// and file:// are not permitted)' },
      400,
    );
  }
  // Credentials in the URL would be written into .git/config in plaintext.
  if (parsed.username || parsed.password) {
    return c.json(
      { error: 'bad_request', message: 'repoUrl must not embed credentials; v1 clones public repositories only' },
      400,
    );
  }

  const branch = (body.branch ?? '').trim();
  if (branch && !/^[\w.\-/]{1,255}$/.test(branch)) {
    return c.json({ error: 'bad_request', message: 'branch contains invalid characters' }, 400);
  }
  const depth = Number.isInteger(body.depth) && (body.depth as number) > 0 ? Math.min(body.depth as number, 1000) : 1;

  let targetPath: string;
  try {
    const name = (body.targetDir ?? '').trim() || defaultRepoDir(parsed.pathname);
    targetPath = resolveWorkspacePath(name);
  } catch (err) {
    return c.json({ error: 'bad_request', message: err instanceof Error ? err.message : String(err) }, 400);
  }

  const cmd =
    `git clone --depth ${depth}` +
    (branch ? ` --branch ${shellQuote(branch)}` : '') +
    ` -- ${shellQuote(repoUrl)} ${shellQuote(targetPath)}`;

  try {
    const result = await runInBoundary(c.env, agentId, cmd, { timeoutMs: 300_000 });
    return c.json({
      ok: result.exitCode === 0,
      agentId,
      repoUrl,
      targetPath,
      ...result,
      // A denial from the guard is the single most likely failure here, so name
      // it explicitly rather than making the agent parse git's stderr.
      egressDenied: /egress denied/i.test(result.stderr) || /egress denied/i.test(result.stdout),
    });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

/** Derive `repo` from `/owner/repo.git`, falling back to a safe constant. */
function defaultRepoDir(pathname: string): string {
  const last = pathname.split('/').filter(Boolean).pop() ?? 'repo';
  const cleaned = last.replace(/\.git$/i, '').replace(/[^\w.\-]/g, '');
  return cleaned || 'repo';
}

// ── files ──────────────────────────────────────────────────────────────────
terminal.post('/hosted/agent/terminal/file/read', async (c) => {
  const agentId = c.var.agentId;
  let body: { path?: string; maxBytes?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
  }
  let path: string;
  try {
    path = resolveWorkspacePath(body.path ?? '');
  } catch (err) {
    return c.json({ error: 'bad_request', message: err instanceof Error ? err.message : String(err) }, 400);
  }
  const maxBytes = Math.min(Math.max(Number(body.maxBytes) || 200_000, 1), 2_000_000);

  try {
    // Read INSIDE the boundary (as the terminal user) so the file tools cannot
    // reach anything the shell couldn't — notably ~hermes/.hermes/.env.
    const result = await runInBoundary(c.env, agentId, `head -c ${maxBytes} -- ${shellQuote(path)}`);
    if (result.exitCode !== 0) {
      return c.json({ ok: false, agentId, path, error: 'read_failed', stderr: result.stderr }, 404);
    }
    return c.json({ ok: true, agentId, path, content: result.stdout, truncated: result.truncated });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

terminal.post('/hosted/agent/terminal/file/write', async (c) => {
  const agentId = c.var.agentId;
  let body: { path?: string; content?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
  }
  let path: string;
  try {
    path = resolveWorkspacePath(body.path ?? '');
  } catch (err) {
    return c.json({ error: 'bad_request', message: err instanceof Error ? err.message : String(err) }, 400);
  }
  const content = String(body.content ?? '');
  if (content.length > 5_000_000) {
    return c.json({ error: 'bad_request', message: 'content too large (max 5MB)' }, 400);
  }

  // Base64 so arbitrary bytes (newlines, quotes, UTF-8, binary) survive the
  // shell round-trip without any quoting cleverness to get wrong.
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(content)));
  const cmd =
    `mkdir -p -- "$(dirname ${shellQuote(path)})" && ` +
    `printf %s ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`;

  try {
    const result = await runInBoundary(c.env, agentId, cmd);
    return c.json({
      ok: result.exitCode === 0,
      agentId,
      path,
      bytes: content.length,
      ...(result.exitCode === 0 ? {} : { stderr: result.stderr }),
    });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

terminal.post('/hosted/agent/terminal/file/list', async (c) => {
  const agentId = c.var.agentId;
  let body: { path?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  let path: string;
  try {
    path = resolveWorkspacePath(body.path || WORKSPACE_ROOT);
  } catch (err) {
    return c.json({ error: 'bad_request', message: err instanceof Error ? err.message : String(err) }, 400);
  }

  try {
    const result = await runInBoundary(c.env, agentId, `ls -lAh --color=never -- ${shellQuote(path)}`);
    return c.json({ ok: result.exitCode === 0, agentId, path, listing: result.stdout, stderr: result.stderr });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

// ── preview URLs ───────────────────────────────────────────────────────────
terminal.post('/hosted/agent/terminal/expose-port', async (c) => {
  const agentId = c.var.agentId;
  let body: { port?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
  }
  const port = Number(body.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return c.json({ error: 'bad_request', message: 'port must be an integer in 1024-65535' }, 400);
  }
  // Never let a caller expose the infrastructure ports: 18789 is the Hermes API
  // (whose bearer token would then be brute-forceable from the open internet),
  // 9119 the dashboard, and 3128 the egress guard — exposing the guard would
  // turn it into an OPEN PROXY reachable by anyone with the preview URL.
  const RESERVED = new Set([18789, 9119, 3128]);
  if (RESERVED.has(port)) {
    return c.json({ error: 'bad_request', message: `port ${port} is reserved by the platform` }, 400);
  }

  const container = getContainerForAgent(c.env, agentId);
  try {
    await ensureTerminalBoundary(container, agentId, allowlistFor(c.env));
    const exposed = await (container as unknown as {
      exposePort(p: number, o: Record<string, unknown>): Promise<{ url?: string }>;
    }).exposePort(port, { name: `agent-${agentId}-${port}` });
    return c.json({ ok: true, agentId, port, url: exposed?.url ?? null });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

// ── Google Workspace CLI ───────────────────────────────────────────────────
/**
 * Run a `gws` command against the caller's Google Workspace account.
 *
 * The OAuth access token arrives in the X-Workspace-Token HEADER, never in the
 * body or URL: bodies get logged by intermediaries and URLs end up in access
 * logs and referrers. Divinci mints it per-request from the customer's stored
 * refresh token; it is short-lived, scoped to that user, injected into the
 * command's environment for one invocation, and never written to disk (no
 * ~/.config/gws/credentials.json is created).
 *
 * Argument validation IS the right control here, unlike `exec`: the surface is
 * a fixed binary rather than an arbitrary shell, so a shell metacharacter in
 * the arguments would let a caller chain a second command that inherits the
 * OAuth token from the environment.
 */
terminal.post('/hosted/agent/terminal/workspace', async (c) => {
  const agentId = c.var.agentId;

  if (c.env.HERMES_WORKSPACE_CLI_ENABLED !== 'true') {
    return c.json(
      { error: 'workspace_cli_disabled', message: 'The Google Workspace CLI is not enabled for this deployment.' },
      404,
    );
  }

  const token = c.req.header('x-workspace-token') ?? '';
  if (!token) {
    return c.json(
      { error: 'bad_request', message: 'X-Workspace-Token header is required (a Google OAuth access token)' },
      400,
    );
  }

  let body: { args?: string; cwd?: string; timeoutMs?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
  }

  let args: string;
  try {
    args = validateWorkspaceArgs(body.args ?? '');
  } catch (err) {
    return c.json({ error: 'bad_request', message: err instanceof Error ? err.message : String(err) }, 400);
  }

  const container = getContainerForAgent(c.env, agentId);
  try {
    await ensureTerminalBoundary(container, agentId, allowlistFor(c.env));
    const timeout = Math.min(Math.max(body.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
    const wrapped = buildWorkspaceCommand(args, token, body.cwd);

    const result = await withRetry<{ stdout?: string; stderr?: string; exitCode?: number }>(
      () => (container as unknown as ExecLike).exec(wrapped, { timeout }),
      // Never retry: a Workspace call can create a draft, an event, or a file.
      // Re-running because the first attempt looked flaky duplicates real
      // side effects in a customer's account.
      { attempts: 1, timeoutMs: timeout + 15_000, isRetryable: () => false, label: `gws:${agentId}` },
    );

    const out = truncateOutput(result.stdout);
    const err = truncateOutput(result.stderr);
    return c.json({
      ok: (result.exitCode ?? 0) === 0,
      agentId,
      // Echo the ARGS, never the token.
      args,
      stdout: out.text,
      stderr: err.text,
      exitCode: result.exitCode ?? 0,
      truncated: out.truncated || err.truncated,
    });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

// ── boundary status (ops / support) ────────────────────────────────────────
terminal.get('/hosted/agent/terminal/status', async (c) => {
  const agentId = c.var.agentId;
  try {
    // Prove the boundary from the inside: report the effective uid and confirm
    // the credential file is unreadable. This is what an operator should check
    // before believing the terminal is contained.
    const result = await runInBoundary(
      c.env,
      agentId,
      'printf "uid=%s user=%s\\n" "$(id -u)" "$(id -un)"; ' +
        'if [ -r /home/hermes/.hermes/.env ]; then echo "creds=READABLE"; else echo "creds=blocked"; fi',
    );
    const uid = (result.stdout.match(/uid=(\d+)/) || [])[1] ?? '';
    return c.json({
      ok: true,
      agentId,
      uid,
      nonRoot: uid !== '' && uid !== '0',
      credentialsBlocked: /creds=blocked/.test(result.stdout),
      workspace: WORKSPACE_ROOT,
      allowlist: allowlistFor(c.env).split(','),
      raw: result.stdout,
    });
  } catch (err) {
    return boundaryFailure(c, err);
  }
});

export { terminal };
