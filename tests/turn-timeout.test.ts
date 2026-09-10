import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  resolveTurnTimeoutMs,
  DEFAULT_TURN_TIMEOUT_MS,
  MIN_TURN_TIMEOUT_MS,
  MAX_TURN_TIMEOUT_MS,
} from '../src/lib/turn-timeout';

/**
 * The per-turn ceiling is the ONLY timeout on the wake path: Cloudflare
 * bounds a Durable Object HTTP request at "unlimited while the caller remains
 * connected", and Divinci's `dispatchHermesChat` is a bare `fetch` with no
 * signal. So if this value regresses, wakes are cut off and the only symptom
 * is `skip=turn_failed` in the sweep log — which reads like a model problem.
 */
describe('resolveTurnTimeoutMs', () => {
  it('defaults to ten minutes when unset', () => {
    expect(resolveTurnTimeoutMs(undefined)).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs(null)).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs('')).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs('   ')).toBe(DEFAULT_TURN_TIMEOUT_MS);
  });

  it('is strictly longer than the 300s that was cutting wakes off', () => {
    expect(DEFAULT_TURN_TIMEOUT_MS).toBeGreaterThan(300_000);
  });

  /**
   * The sweep runs agents serially and rides a cron that fires every ten
   * minutes. A per-turn ceiling above the cadence lets one agent's turn
   * overlap the next firing, so the default must not exceed it.
   */
  it('does not exceed the ten-minute cron cadence it rides', () => {
    expect(DEFAULT_TURN_TIMEOUT_MS).toBeLessThanOrEqual(600_000);
  });

  /**
   * A turn allowed to outlive the whole cron invocation cannot finish under
   * any circumstances — it would convert a clean timeout into a killed sweep.
   */
  it('never permits a turn longer than the 15-minute cron wall clock', () => {
    expect(MAX_TURN_TIMEOUT_MS).toBeLessThanOrEqual(900_000);
    expect(resolveTurnTimeoutMs('99999999')).toBe(MAX_TURN_TIMEOUT_MS);
  });

  it('clamps rather than refusing, in both directions', () => {
    expect(resolveTurnTimeoutMs('1')).toBe(MIN_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs(String(MAX_TURN_TIMEOUT_MS + 1))).toBe(MAX_TURN_TIMEOUT_MS);
    expect(resolveTurnTimeoutMs('450000')).toBe(450_000);
  });

  /**
   * Fails SAFE, not closed. A typo in a Worker env var must not take every
   * agent's wake offline; it must fall back to a value that works.
   */
  it('falls back to the default on garbage instead of throwing', () => {
    for (const junk of ['abc', 'NaN', '-1', '0', '1e', '{}']) {
      expect(resolveTurnTimeoutMs(junk)).toBe(DEFAULT_TURN_TIMEOUT_MS);
    }
  });

  /**
   * The call site is the whole point of the module. A refactor that inlines a
   * literal back into `hosted.ts` would leave every test above passing while
   * restoring the bug, so assert the wiring in the source itself.
   */
  it('is the value hosted.ts actually passes to containerFetch', () => {
    const src = readFileSync(new URL('../src/routes/hosted.ts', import.meta.url), 'utf8');
    expect(src).toContain('timeoutMs: resolveTurnTimeoutMs(c.env.HERMES_TURN_TIMEOUT_MS)');

    // Scoped to the chat-completions handler on purpose. The other 300s
    // ceilings in this file (boot, ensure, proxy, slack-restart) bound
    // different callers — a human waiting on a proxied request is not a
    // metered wake — so a blanket assertion would forbid changes that are
    // fine and, worse, would pass for the wrong reason if this block moved.
    const chatBlock = src.slice(src.indexOf("/v1/chat/completions"));
    const at = chatBlock.indexOf("containerFetch(upstream, HERMES_API_PORT)");
    expect(at).toBeGreaterThan(-1);
    const opts = chatBlock.slice(at, at + 500);
    expect(opts).not.toMatch(/timeoutMs:\s*\d/);
  });
});
