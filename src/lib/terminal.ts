/**
 * Virtual-terminal boundary enforcement.
 *
 * The terminal lets a Hermes agent clone repositories, write code, and run
 * commands. The security model is deliberately NOT "filter the command string" —
 * that is unwinnable, and the whole point of the feature is to run arbitrary
 * commands. Instead the boundary is structural, enforced by the OS:
 *
 *   - commands run as `hermes-term` (uid 10002), which cannot read the provider
 *     credentials under ~hermes/.hermes/;
 *   - they start from an EMPTY environment (`env -i`) plus a tiny allowlist, so
 *     nothing leaks in through inherited vars;
 *   - all egress is REJECTed by iptables owner-match except loopback to the
 *     allowlisting proxy;
 *   - file tools are confined to /workspace by path resolution here.
 *
 * `setup-terminal.sh` establishes layers 1-3 at container boot and exits
 * non-zero if any of them cannot be established. `ensureTerminalBoundary()`
 * refuses to run anything until that script has succeeded, so a container where
 * the lockdown failed serves no terminal traffic at all. There is no
 * best-effort mode: a terminal without egress control is a different product
 * from the one we reviewed.
 */

const SETUP_SCRIPT = '/usr/local/bin/setup-terminal.sh';

export const WORKSPACE_ROOT = '/workspace';
export const TERMINAL_USER = 'hermes-term';
export const EGRESS_PROXY_PORT = 3128;
export const PROXY_HOST = '127.0.0.1';

/**
 * Default egress allowlist: the package registries and forges a build actually
 * needs, and nothing else. Overridable per-deploy via EGRESS_ALLOWED_HOSTS.
 * Entries are matched as exact hosts or dot-anchored suffixes by the guard.
 */
export const DEFAULT_EGRESS_ALLOWLIST = [
  'github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
  'gitlab.com',
  'registry.npmjs.org',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'proxy.golang.org',
].join(',');

/**
 * Per-container memo of the boundary result. The DO instance is per-agent and
 * lives as long as the container, so this runs the setup script once per boot
 * rather than on every command. Keyed by agent id; a rejected promise is NOT
 * cached, so a transient failure can be retried on the next call.
 */
const boundaryByAgent = new Map<string, Promise<void>>();

export class TerminalBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalBoundaryError';
  }
}

interface ExecLike {
  exec(command: string, options?: Record<string, unknown>): Promise<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
}

/**
 * Run the boot-time lockdown for this container, once. Throws
 * TerminalBoundaryError if the boundary cannot be established — callers must
 * map that to a 503 and MUST NOT fall back to running the command.
 */
export async function ensureTerminalBoundary(
  container: unknown,
  agentId: string,
  allowedHosts: string,
): Promise<void> {
  const existing = boundaryByAgent.get(agentId);
  if (existing) return existing;

  const run = (async () => {
    const c = container as ExecLike;
    // The script is idempotent (it flushes and rebuilds its own iptables chain),
    // so re-running after a container restart is safe.
    const result = await c.exec(
      `EGRESS_ALLOWED_HOSTS=${shellQuote(allowedHosts)} ` +
        `EGRESS_PROXY_PORT=${EGRESS_PROXY_PORT} ${SETUP_SCRIPT}`,
      { timeout: 120_000 },
    );
    if ((result.exitCode ?? 1) !== 0) {
      throw new TerminalBoundaryError(
        `terminal boundary could not be established (exit ${result.exitCode}): ` +
          `${(result.stderr || result.stdout || '').slice(0, 800)}`,
      );
    }
  })();

  boundaryByAgent.set(agentId, run);
  try {
    await run;
  } catch (err) {
    // Do not cache failure — a transient boot race should be retryable.
    boundaryByAgent.delete(agentId);
    throw err;
  }
}

/** Drop a container's memoized boundary (used when the container is stopped). */
export function forgetTerminalBoundary(agentId: string): void {
  boundaryByAgent.delete(agentId);
}

/** POSIX single-quote quoting — safe for arbitrary content including quotes. */
export function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolve a caller-supplied path against the workspace root and verify it stays
 * inside. Rejects absolute paths outside /workspace, `..` escapes, and NUL
 * bytes. Normalization happens BEFORE the containment check — checking a raw
 * string for ".." and then normalizing is the classic ordering bug (the same
 * one the Divinci-side SSRF guard documents).
 */
export function resolveWorkspacePath(input: string): string {
  const raw = String(input ?? '').trim();
  if (!raw) throw new TerminalBoundaryError('path is required');
  if (raw.includes('\0')) throw new TerminalBoundaryError('path contains a NUL byte');

  const joined = raw.startsWith('/') ? raw : `${WORKSPACE_ROOT}/${raw}`;

  // Manual POSIX normalization — there is no node:path in the Workers runtime.
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) throw new TerminalBoundaryError('path escapes the workspace');
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = `/${parts.join('/')}`;

  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
    throw new TerminalBoundaryError(`path escapes the workspace (${WORKSPACE_ROOT})`);
  }
  return resolved;
}

/**
 * Wrap a command so it runs as the terminal user with a clean, explicit
 * environment.
 *
 * `env -i` is load-bearing. The Sandbox SDK's per-exec `env` option can only
 * OVERRIDE variables, never unset them, so any inherited credential would still
 * be readable by the command. Starting from empty and adding back a known-safe
 * set is the only way to guarantee what the process can see.
 *
 * The proxy variables make well-behaved tools use the egress guard; the iptables
 * rules are what make it mandatory for the rest.
 */
export function buildTerminalCommand(command: string, cwd?: string): string {
  const workdir = cwd ? resolveWorkspacePath(cwd) : WORKSPACE_ROOT;
  const proxy = `http://127.0.0.1:${EGRESS_PROXY_PORT}`;

  const env = [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `HOME=${WORKSPACE_ROOT}`,
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    'TERM=dumb',
    `HTTP_PROXY=${proxy}`,
    `HTTPS_PROXY=${proxy}`,
    `http_proxy=${proxy}`,
    `https_proxy=${proxy}`,
    // Loopback must not be proxied or the guard would recurse into itself.
    'NO_PROXY=127.0.0.1,localhost',
    'no_proxy=127.0.0.1,localhost',
    // Keep package managers from phoning home with telemetry we cannot audit.
    'DO_NOT_TRACK=1',
    'npm_config_fund=false',
    'npm_config_audit=false',
  ].map(shellQuote).join(' ');

  // `bash -lc` so the agent gets a normal shell (pipes, &&, globs) — the point
  // of a terminal. Confinement comes from the uid and the network, not from
  // restricting shell syntax.
  //
  // NOT `exec gosu`. The Sandbox SDK runs commands inside a PERSISTENT session
  // shell, and `exec` replaces that shell with gosu — so the session is gone
  // the moment the command finishes and the SDK reports
  //   Session 'sandbox-default' shell exited (exit code: 0)
  // even though the command ran fine. Running gosu as an ordinary child leaves
  // the session shell alive to serve the next command.
  return (
    `cd ${shellQuote(workdir)} 2>/dev/null || cd ${shellQuote(WORKSPACE_ROOT)}; ` +
    `gosu ${TERMINAL_USER} env -i ${env} bash -lc ${shellQuote(command)}`
  );
}

/**
 * Google API hosts the Workspace CLI needs.
 *
 * These are added to the egress allowlist for the WHOLE container when the
 * Workspace feature is enabled for it (HERMES_WORKSPACE_CLI_ENABLED), not
 * per-command: the guard is a long-running process that reads its allowlist
 * once at boot, so there is no honest way to narrow it to the duration of a
 * single invocation.
 *
 * That is a real widening, so it is opt-in and off by default. An agent with
 * the Workspace feature enabled can reach googleapis.com from any command, not
 * just from `gws` — the thing that stops that being an open exfiltration
 * channel is that reaching an authenticated Google endpoint still requires a
 * token, and tokens are injected per-command and never persisted.
 */
export const WORKSPACE_EGRESS_HOSTS = [
  'googleapis.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
].join(',');

/**
 * Hosts needed by the platform CLIs baked into the image (`gcloud`, `wrangler`).
 *
 * Same whole-container widening caveat as WORKSPACE_EGRESS_HOSTS: the egress
 * guard reads its allowlist once at boot, so these cannot honestly be scoped to
 * a single invocation. Off unless HERMES_PLATFORM_CLI_ENABLED=true.
 *
 * - googleapis.com / accounts.google.com — gcloud control plane + OAuth
 * - api.cloudflare.com — wrangler deploy / whoami / Workers API
 *
 * Tokens are still required for anything useful; an empty allowlist would only
 * let the binaries print `--version`. Reaching an authenticated endpoint without
 * a credential still fails at the API.
 */
export const PLATFORM_EGRESS_HOSTS = [
  'googleapis.com',
  'oauth2.googleapis.com',
  'www.googleapis.com',
  'accounts.google.com',
  'api.cloudflare.com',
].join(',');

/**
 * Compose the egress allowlist for a container boot from env feature flags.
 * Pure string join — unit-tested without spinning a container.
 */
export function composeTerminalAllowlist(opts: {
  base?: string;
  workspaceCliEnabled?: boolean;
  platformCliEnabled?: boolean;
}): string {
  let hosts = opts.base && opts.base.length > 0 ? opts.base : DEFAULT_EGRESS_ALLOWLIST;
  if (opts.workspaceCliEnabled) hosts = `${hosts},${WORKSPACE_EGRESS_HOSTS}`;
  if (opts.platformCliEnabled) hosts = `${hosts},${PLATFORM_EGRESS_HOSTS}`;
  return hosts;
}

/**
 * Build a `gws` invocation with a short-lived OAuth access token.
 *
 * The token is the customer's own Workspace credential, so it is handled more
 * carefully than ordinary command input:
 *
 *  - It is passed via the environment, NOT on the command line. Argv is visible
 *    to every process in the container through /proc/<pid>/cmdline; the
 *    environment of a process is only readable by its own uid.
 *  - It is scoped to ONE command. Nothing is written to
 *    ~/.config/gws/credentials.json, so it cannot outlive the invocation or be
 *    picked up by a later command.
 *  - `set +x` guards against the shell echoing it if tracing is ever enabled.
 *
 * Note the egress allowlist is doing real work here too: even if a prompt
 * injection in a cloned repo convinced the agent to exfiltrate this token, it
 * has nowhere to send it — outbound traffic is REJECTed except to the
 * allowlisted hosts.
 */
export function buildWorkspaceCommand(args: string, accessToken: string, cwd?: string): string {
  if (!accessToken || typeof accessToken !== 'string') {
    throw new TerminalBoundaryError('a Google Workspace access token is required');
  }
  // Restrict to the characters a real OAuth 2.0 bearer token can contain
  // (RFC 6750 token68: ALPHA / DIGIT / "-" / "." / "_" / "~" / "+" / "/" / "=").
  // Deliberately narrower than "any printable ASCII": quotes and backslashes
  // have no business in a token, and the value is interpolated into a generated
  // shell script. shellQuote would neutralize them anyway — this is the second
  // lock, so a future refactor that drops the quoting does not become a hole.
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(accessToken)) {
    throw new TerminalBoundaryError('malformed Google Workspace access token');
  }
  const workdir = cwd ? resolveWorkspacePath(cwd) : WORKSPACE_ROOT;
  const proxy = `http://${PROXY_HOST}:${EGRESS_PROXY_PORT}`;

  const env = [
    'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    `HOME=${WORKSPACE_ROOT}`,
    'LANG=C.UTF-8',
    'LC_ALL=C.UTF-8',
    `HTTP_PROXY=${proxy}`,
    `HTTPS_PROXY=${proxy}`,
    `http_proxy=${proxy}`,
    `https_proxy=${proxy}`,
    'NO_PROXY=127.0.0.1,localhost',
    'no_proxy=127.0.0.1,localhost',
    `GOOGLE_WORKSPACE_CLI_TOKEN=${accessToken}`,
  ].map(shellQuote).join(' ');

  // Do NOT use `exec` here: the Sandbox session shell is a long-lived process.
  // `exec gosu …` replaced it and the next command failed with
  // "Session 'sandbox-default' shell exited" (seen 2026-08-07 on staging
  // workspace CLI probes). Mirror buildTerminalCommand: run gosu as a child.
  return (
    `set +x; cd ${shellQuote(workdir)} 2>/dev/null || cd ${shellQuote(WORKSPACE_ROOT)}; ` +
    `gosu ${TERMINAL_USER} env -i ${env} gws ${args}`
  );
}

/**
 * Validate the argument string for a `gws` invocation.
 *
 * Unlike `exec`, this is NOT a general shell: the arguments are appended after
 * `gws`, so shell metacharacters would let a caller chain a second command that
 * inherits the OAuth token in its environment. That is the one place where
 * input filtering IS the right control, because the surface is a fixed binary
 * rather than an arbitrary shell.
 */
const GWS_ARG_PATTERN = /^[A-Za-z0-9 _\-./:@=,'"?&+*[\]{}#]+$/;

export function validateWorkspaceArgs(args: string): string {
  const a = String(args ?? '').trim();
  if (!a) throw new TerminalBoundaryError('workspace command arguments are required');
  if (a.length > 4_000) throw new TerminalBoundaryError('workspace command is too long');
  // Explicitly reject the metacharacters that could start a new command or
  // capture output, before the permissive allowlist below.
  if (/[;&|`$<>\\\n\r()]/.test(a)) {
    throw new TerminalBoundaryError(
      'workspace command arguments may not contain shell metacharacters',
    );
  }
  if (!GWS_ARG_PATTERN.test(a)) {
    throw new TerminalBoundaryError('workspace command arguments contain unsupported characters');
  }
  return a;
}

/** Cap on captured output per stream, so one command can't blow the response. */
export const MAX_OUTPUT_CHARS = 100_000;

export function truncateOutput(value: string | undefined): { text: string; truncated: boolean } {
  const s = value ?? '';
  if (s.length <= MAX_OUTPUT_CHARS) return { text: s, truncated: false };
  // Keep the TAIL: errors, stack traces, and test summaries live at the end.
  return { text: s.slice(s.length - MAX_OUTPUT_CHARS), truncated: true };
}
