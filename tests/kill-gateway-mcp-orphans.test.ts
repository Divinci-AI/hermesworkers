import { describe, it, expect } from 'vitest';
import { killGateway } from '../src/services/container-lifecycle';

/**
 * KNOWN-GAPS: hermes-terminal-mcp-drops-and-the-agent-narrates-instead-of-failing
 *
 * Hermes reaps its stdio MCP subprocesses on a graceful exit. It cannot reap
 * them after a hard one: `_orphan_stdio_pids` — the registry both
 * `MCPServerTask.shutdown()` and the startup sweep read — is in-process state,
 * so SIGKILL destroys the list of what to reap together with the process that
 * held it. `killGateway` escalates to SIGKILL after a 3s grace, so every
 * restart that overruns that grace leaves a live mcp-terminal-server behind.
 *
 * Four were counted in a live container on 2026-08-23, the same day
 * divinci_terminal went unreachable on two agents at once and recovered on its
 * own ~25 minutes later.
 */
function fakeContainer() {
  const calls: string[] = [];
  return {
    calls,
    stub: {
      exec: async (cmd: string) => {
        calls.push(cmd);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      // findGatewayProcess() probes this; "unsupported" is a normal answer.
      listProcesses: async () => {
        throw new Error('not supported');
      },
    } as never,
  };
}

const noSleep = async () => {};

describe('killGateway reaps orphaned MCP terminal children', () => {
  it('sweeps mcp-terminal-server after the gateway is gone', async () => {
    const { calls, stub } = fakeContainer();
    await killGateway(stub, noSleep);

    const sweep = calls.filter((c) => c.includes('mcp-terminal-server.js'));
    expect(sweep, 'no sweep for orphaned MCP terminal children').toHaveLength(1);
    expect(sweep[0]).toMatch(/kill -9/);
  });

  it('sweeps only AFTER the gateway kill, never before', async () => {
    // Ordering is the whole safety argument: a live gateway owns a legitimate
    // mcp-terminal-server, and sweeping first would kill the terminal out from
    // under a gateway that is about to survive the SIGTERM.
    const { calls, stub } = fakeContainer();
    await killGateway(stub, noSleep);

    const lastGatewayKill = calls.findLastIndex((c) => c.includes('hermes gateway'));
    const sweepAt = calls.findIndex((c) => c.includes('mcp-terminal-server.js'));
    expect(lastGatewayKill).toBeGreaterThanOrEqual(0);
    expect(sweepAt).toBeGreaterThan(lastGatewayKill);
  });

  it('still tries SIGTERM before SIGKILL', async () => {
    const { calls, stub } = fakeContainer();
    await killGateway(stub, noSleep);
    const term = calls.findIndex((c) => c.includes('kill -TERM'));
    const force = calls.findIndex((c) => c.includes('kill -9') && c.includes('hermes gateway'));
    expect(term).toBeGreaterThanOrEqual(0);
    expect(force).toBeGreaterThan(term);
  });

  it('a failing sweep does not fail the kill', async () => {
    const calls: string[] = [];
    const stub = {
      exec: async (cmd: string) => {
        calls.push(cmd);
        if (cmd.includes('mcp-terminal-server.js')) throw new Error('exec died');
        return { stdout: '', stderr: '', exitCode: 0 };
      },
      listProcesses: async () => {
        throw new Error('not supported');
      },
    } as never;

    await expect(killGateway(stub, noSleep)).resolves.toBeUndefined();
  });
});
