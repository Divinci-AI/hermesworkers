/**
 * How long a single hosted Hermes turn may hold its `containerFetch` open.
 *
 * ⚠️ THE PLATFORM DOES NOT BOUND THIS. Cloudflare documents the wall time of
 * a Durable Object HTTP request as "unlimited while the caller remains
 * connected", and nothing on the path from Divinci's `proactive-tick` to this
 * Worker sets a timeout of its own — `dispatchHermesChat` is a bare `fetch`.
 * So every ceiling a wake can hit is one we chose, and this is the tightest
 * one. It read `300_000` from the day it was written, which is why long wakes
 * ended in `turn_failed` at almost exactly five minutes.
 *
 * WHY IT IS NOT SIMPLY LARGE. `proactive-tick` runs its due agents SERIALLY
 * inside one HTTP request, and that request is issued from the
 * connector-sync-worker's `*∕10` cron branch, sequentially between the Slack
 * keepalive and the fleet digest. Cloudflare caps a cron invocation at 15
 * minutes of wall clock, and the branch fires again every 10. So the binding
 * budget is the CADENCE, not the cap: at the default, one long agent can
 * consume an entire sweep without the sweep overlapping the next firing.
 *
 * This value and `proactive-tick`'s own sweep deadline are one setting
 * expressed in two repositories. Raising this past the sweep deadline just
 * moves the failure — the sweep abandons the agent instead of the fetch
 * timing out.
 */
export const DEFAULT_TURN_TIMEOUT_MS = 600_000;

/**
 * Floor: below this a turn cannot complete even a trivial tool call, so a
 * typo'd override would silently fail every wake rather than loudly refusing.
 */
export const MIN_TURN_TIMEOUT_MS = 30_000;

/**
 * Ceiling: the Cloudflare cron wall-clock limit that ultimately contains the
 * sweep. A turn permitted to run longer than the whole cron invocation cannot
 * finish under any circumstances, so allowing it would only convert a clean
 * timeout into a killed sweep that reports nothing.
 */
export const MAX_TURN_TIMEOUT_MS = 900_000;

/**
 * Parse the `HERMES_TURN_TIMEOUT_MS` override.
 *
 * Fails SAFE rather than closed: anything unparseable falls back to the
 * default instead of throwing, because the alternative is a env-var typo
 * taking the whole fleet's wakes offline. Out-of-range values clamp, so an
 * operator reaching for a big number during an incident gets the largest
 * workable one rather than a refusal.
 */
export function resolveTurnTimeoutMs(raw: string | undefined | null): number {
  const n = Number((raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TURN_TIMEOUT_MS;
  return Math.min(MAX_TURN_TIMEOUT_MS, Math.max(MIN_TURN_TIMEOUT_MS, Math.floor(n)));
}
