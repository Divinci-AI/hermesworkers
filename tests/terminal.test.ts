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
  TerminalBoundaryError,
  WORKSPACE_ROOT,
  buildTerminalCommand,
  ensureTerminalBoundary,
  forgetTerminalBoundary,
  resolveWorkspacePath,
  shellQuote,
  truncateOutput,
  MAX_OUTPUT_CHARS,
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
