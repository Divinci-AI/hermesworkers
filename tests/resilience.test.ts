import { describe, it, expect } from 'vitest';
import { withRetry, TimeoutError } from '../src/lib/resilience';

// Deterministic knobs: no real waiting, fixed jitter.
const noSleep = async () => {};
const fixedRandom = () => 0.5;

describe('withRetry', () => {
  it('returns on first success without retrying', async () => {
    let calls = 0;
    const out = await withRetry(async () => { calls++; return 'ok'; }, { sleep: noSleep, random: fixedRandom });
    expect(out).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries a transient failure and then succeeds', async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
        return 'recovered';
      },
      { attempts: 3, sleep: noSleep, random: fixedRandom },
    );
    expect(out).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error(`fail-${calls}`); }, {
        attempts: 3, sleep: noSleep, random: fixedRandom,
      }),
    ).rejects.toThrow('fail-3');
    expect(calls).toBe(3);
  });

  it('does not retry when isRetryable returns false', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new Error('fatal'); }, {
        attempts: 5,
        isRetryable: () => false,
        sleep: noSleep,
        random: fixedRandom,
      }),
    ).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });

  it('enforces a per-attempt timeout', async () => {
    // fn never resolves within the timeout; injected sleep resolves the backoff.
    await expect(
      withRetry(() => new Promise(() => {}), {
        attempts: 1,
        timeoutMs: 5,
        sleep: noSleep,
        random: fixedRandom,
        label: 'stuck',
      }),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it('passes the attempt number to the callback', async () => {
    const seen: number[] = [];
    await withRetry(
      async (attempt) => { seen.push(attempt); if (attempt < 3) throw new Error('again'); return 'done'; },
      { attempts: 3, sleep: noSleep, random: fixedRandom },
    );
    expect(seen).toEqual([1, 2, 3]);
  });
});
