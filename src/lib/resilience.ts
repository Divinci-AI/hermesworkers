/**
 * Resiliency helpers for Durable Object / container calls.
 *
 * Container interactions (startProcess, exec, containerFetch, waitForPort) can
 * transiently fail while a Sandbox wakes from sleep, or hang. Every such call
 * should go through `withRetry` so a single blip doesn't surface as a user-facing
 * error, and a hung call can't pin a request open indefinitely.
 *
 * Injectable `sleep` / `random` keep this unit-testable without real timers.
 */

export interface RetryOptions {
  /** Max attempts total (including the first). Default 3. */
  attempts?: number;
  /** Base backoff in ms; grows exponentially with full jitter. Default 250. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff delay. Default 5000. */
  maxDelayMs?: number;
  /** Per-attempt timeout in ms; the attempt rejects if it exceeds this. Default 30000. */
  timeoutMs?: number;
  /** Decide whether a given error is worth retrying. Default: retry everything. */
  isRetryable?: (err: unknown) => boolean;
  /** Injectable sleep (testing). */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable [0,1) source (testing). */
  random?: () => number;
  /** Optional label for logs. */
  label?: string;
}

export class TimeoutError extends Error {
  constructor(ms: number, label?: string) {
    super(`Operation${label ? ` "${label}"` : ''} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string | undefined,
): Promise<T> {
  if (!ms || ms <= 0) return fn();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError(ms, label));
    }, ms);
    fn().then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run `fn` with a per-attempt timeout and bounded exponential backoff + full
 * jitter. Rejects with the last error once attempts are exhausted (or
 * immediately when `isRetryable` returns false).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 250;
  const maxDelayMs = opts.maxDelayMs ?? 5000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const isRetryable = opts.isRetryable ?? (() => true);
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(() => fn(attempt), timeoutMs, opts.label);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) break;
      // Full jitter: delay in [0, min(max, base * 2^(attempt-1))].
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.floor(random() * ceiling));
    }
  }
  throw lastErr;
}
