import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

/**
 * KNOWN-GAPS: hermes-terminal-mcp-drops-and-the-agent-narrates-instead-of-failing
 *
 * A nonzero command exit must NOT be reported as an MCP tool error.
 *
 * Hermes' MCP client treats any tool result carrying an "error" key as
 * evidence the SERVER is unhealthy — tools/mcp_tool.py:
 *
 *     result = _call_once()            # the call SUCCEEDED
 *     parsed = json.loads(result)
 *     if "error" in parsed:
 *         _bump_server_error(server_name)
 *
 * — and opens a circuit breaker after 3 consecutive such results, refusing
 * every terminal call for 60s. For a shell, a nonzero exit is the most common
 * normal outcome, so marking it isError made the terminal disable itself
 * during ordinary work. Measured in production on 2026-08-24: of 12 terminal
 * "errors", 6 were ordinary nonzero exits, 2 were egress-allowlist 403s, and 2
 * were the breaker refusing calls off the back of them. The agent then told
 * Slack the terminal was down and would "be back in a minute" — the 60s
 * cooldown, narrated as an outage.
 *
 * The exit status is not lost: it rides in the text as `[exit N]`, asserted
 * below, so the agent can still tell success from failure.
 */
const here = dirname(fileURLToPath(import.meta.url));
const SERVER = join(here, '..', 'container', 'mcp-terminal-server.js');

let out: Record<string, unknown>;

beforeAll(() => {
  // /usr/local/bin has no package.json, so the file is CommonJS in the
  // container; the repo's package.json sets "type": "module".
  const dir = mkdtempSync(join(tmpdir(), 'mcp-term-exit-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  copyFileSync(SERVER, join(dir, 'server.cjs'));
  writeFileSync(
    join(dir, 'drive.cjs'),
    `const m = require('./server.cjs');
     const res = {};
     res.failed  = m.textResult({ stdout: '', stderr: "mv: 'a' and 'b' are the same file", exitCode: 1 });
     res.ok      = m.textResult({ stdout: 'hello', stderr: '', exitCode: 0 });
     res.notFound= m.textResult({ stdout: '', stderr: 'bash: dig: command not found', exitCode: 127 });
     // callTool is async, so a rejection cannot be caught synchronously —
     // doing so crashes the driver on an unhandled rejection instead.
     Promise.resolve()
       .then(() => m.callTool('read_file', { path: '/etc/passwd' }))
       .then(() => { res.escape = 'DID NOT THROW'; })
       .catch((e) => { res.escape = 'threw: ' + e.message; })
       .then(() => process.stdout.write('@@' + JSON.stringify(res) + '@@'));`,
  );
  const raw = execFileSync('node', [join(dir, 'drive.cjs')], { encoding: 'utf8', input: '' });
  const m = raw.match(/@@([\s\S]*)@@/);
  expect(m, `driver produced no result: ${raw}`).toBeTruthy();
  out = JSON.parse(m![1]!);
});

describe('a nonzero exit is the command failing, not the terminal server', () => {
  it.each([
    ['failed', 1],
    ['notFound', 127],
  ])('%s does not set isError', (key, code) => {
    const r = out[key] as Record<string, unknown>;
    // `in` rather than a truthiness check: isError:false would still serialise
    // an "error"-adjacent field, and the point is that the key is absent.
    expect(r).not.toHaveProperty('isError');
    // The status must survive, or the agent cannot tell pass from fail.
    expect(JSON.stringify(r)).toContain(`[exit ${code}]`);
  });

  it('a successful command is unchanged', () => {
    const r = out.ok as Record<string, unknown>;
    expect(r).not.toHaveProperty('isError');
    expect(JSON.stringify(r)).toContain('hello');
  });

  it('STILL fails a genuine tool failure — a path escaping the workspace', () => {
    // This is the breaker's one legitimate input. Removing isError wholesale
    // would leave nothing able to trip it, so the rejection path must survive.
    expect(out.escape).toMatch(/^threw:/);
  });
});

describe('the source records why, so it is not "simplified" back', () => {
  it('explains the circuit-breaker coupling at the return site', () => {
    const src = readFileSync(SERVER, 'utf8');
    expect(src).toMatch(/NOT isError/);
    expect(src).toMatch(/circuit breaker/i);
  });
});
