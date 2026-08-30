/**
 * Fleet claim leases — the enforced half of "don't dogpile".
 *
 * ═══ WHY THIS EXISTS ═══
 *
 * The Divinci Hermes fleet already coordinates, and every part of it is an
 * INSTRUCTION rather than a mechanism: a shared transcript all agents read,
 * `partnerAgentKey` pairing, and a goal that literally says "divide this work
 * with Team Hermes, Hermes Delta, Hermes Sigma and Hermes Local rather than
 * four of you proposing the same thing — say which lever you are taking".
 *
 * Asking four models to take turns is not turn-taking. The only ENFORCED
 * control today is `mode: shadow`, which does not sequence anything — it mutes
 * an agent entirely. That is why Hermes Sigma wakes 8x a day, at roughly 12x
 * Delta's cost per turn (102 vs 8.6 Cloudflare neurons, measured), into
 * silence: muting is the only volume knob available.
 *
 * A lease is the missing primitive. An agent CLAIMS a named lever for a
 * window; the claim is visible to every other agent and refused if someone
 * already holds it.
 *
 * ═══ WHY A DURABLE OBJECT, NOT KV OR R2 ═══
 *
 * This module is pure so it can be tested without a runtime, but it is meant to
 * run inside a single Durable Object per fleet, because a claim ledger needs
 * STRONG consistency and serialized access.
 *
 * That is not a preference. A previous claim ledger in this codebase was built
 * on R2 and `list()` is eventually consistent, so it broke in BOTH directions
 * at once: duplicate launches (two workers both saw a free slot) and
 * starvation (a released claim kept appearing held). Read-modify-write against
 * an eventually-consistent store cannot implement mutual exclusion. A DO
 * serializes requests, so the check-then-insert below is atomic by
 * construction rather than by hope.
 *
 * ═══ THE FENCING TOKEN ═══
 *
 * Expiry alone is not enough, and this is the classic distributed-lock bug. An
 * agent can be paused — a container evicted, a slow model turn, a GC pause —
 * past its own expiry, wake up still believing it holds the lever, and act
 * while a second agent legitimately holds it. Wall-clock checks on the holder's
 * side cannot fix this; the holder's clock is exactly what is untrustworthy.
 *
 * So every grant carries a monotonically increasing `fence` for that lever, and
 * renew/release must present the fence they were given. A resumed agent
 * presents a stale fence and is refused, which converts a silent double-actor
 * into a loud, checkable rejection.
 */

/** A single held lever. */
export interface Claim {
  /** The work item being claimed. Opaque to this module. */
  lever: string;
  /** Which agent holds it (`agentKey`). */
  holder: string;
  /** Monotonic per-lever grant counter. Renew/release must present it. */
  fence: number;
  /** Epoch ms. Expiry is evaluated at READ time — see `activeClaims`. */
  expiresAt: number;
  /** Epoch ms of first acquisition in this holding streak. */
  acquiredAt: number;
  /** Free-text, for humans reading the board. Never interpreted. */
  note?: string;
}

export interface ClaimState {
  claims: Record<string, Claim>;
  /** Highest fence ever issued per lever, retained across release so a
   *  released-then-reacquired lever never re-issues a fence a paused holder
   *  might still be carrying. */
  fences: Record<string, number>;
}

export type AcquireResult =
  | { ok: true; claim: Claim; state: ClaimState; renewed: boolean }
  | { ok: false; reason: 'held'; by: string; expiresAt: number }
  | { ok: false; reason: 'invalid'; detail: string }
  | { ok: false; reason: 'capacity'; detail: string };

export type ReleaseResult =
  | { ok: true; state: ClaimState }
  | { ok: false; reason: 'not_held' | 'not_holder' | 'stale_fence'; detail: string };

// Bounds. A buggy agent looping on acquire must not grow this without limit —
// the ledger lives in one DO and is read in full on every list.
export const MAX_LEVERS = 200;
export const MAX_LEVER_CHARS = 120;
export const MAX_NOTE_CHARS = 280;
export const MIN_TTL_MS = 30_000;
export const MAX_TTL_MS = 6 * 60 * 60 * 1000; // 6h — longer than any wake

export function emptyState(): ClaimState {
  return { claims: {}, fences: {} };
}

/** Levers are compared verbatim, so they are constrained rather than parsed. */
export function isValidLever(lever: unknown): lever is string {
  return (
    typeof lever === 'string' &&
    lever.length > 0 &&
    lever.length <= MAX_LEVER_CHARS &&
    /^[A-Za-z0-9._:/-]+$/.test(lever)
  );
}

/**
 * Expiry is computed HERE, at read time, never by a scheduled sweep.
 *
 * A sweep that fails to run leaves every lever held forever, and the failure is
 * invisible: the ledger looks busy, agents back off politely, and the fleet
 * goes quiet for the most reassuring possible reason. Evaluating against `now`
 * on every read means a missed tick can never cause starvation.
 */
export function activeClaims(state: ClaimState, now: number): Claim[] {
  return Object.values(state.claims)
    .filter((c) => c.expiresAt > now)
    .sort((a, b) => a.lever.localeCompare(b.lever));
}

export function acquire(
  state: ClaimState,
  req: { lever: string; holder: string; ttlMs: number; note?: string },
  now: number,
): AcquireResult {
  if (!isValidLever(req.lever)) {
    return { ok: false, reason: 'invalid', detail: 'lever must be 1-120 chars of [A-Za-z0-9._:/-]' };
  }
  if (typeof req.holder !== 'string' || !req.holder) {
    return { ok: false, reason: 'invalid', detail: 'holder is required' };
  }
  if (!Number.isFinite(req.ttlMs) || req.ttlMs < MIN_TTL_MS || req.ttlMs > MAX_TTL_MS) {
    return { ok: false, reason: 'invalid', detail: `ttlMs must be ${MIN_TTL_MS}..${MAX_TTL_MS}` };
  }
  if (req.note !== undefined && (typeof req.note !== 'string' || req.note.length > MAX_NOTE_CHARS)) {
    return { ok: false, reason: 'invalid', detail: `note must be <= ${MAX_NOTE_CHARS} chars` };
  }

  const existing = state.claims[req.lever];
  const live = existing && existing.expiresAt > now;

  // Someone else holds it and has not expired: refuse, and say who, so the
  // caller can pick a different lever instead of retrying blind.
  if (live && existing.holder !== req.holder) {
    return { ok: false, reason: 'held', by: existing.holder, expiresAt: existing.expiresAt };
  }

  // Re-acquire by the CURRENT holder is a renew, not a conflict. An agent that
  // retries after a network blip must not deadlock against itself — that turns
  // a transient error into a permanent one.
  if (live && existing.holder === req.holder) {
    const claim: Claim = {
      ...existing,
      expiresAt: now + req.ttlMs,
      note: req.note ?? existing.note,
    };
    return {
      ok: true,
      renewed: true,
      claim,
      state: { claims: { ...state.claims, [req.lever]: claim }, fences: state.fences },
    };
  }

  const activeCount = activeClaims(state, now).length;
  if (!existing && activeCount >= MAX_LEVERS) {
    return { ok: false, reason: 'capacity', detail: `at most ${MAX_LEVERS} active claims` };
  }

  // Fresh grant (free, or the previous holder expired). The fence increments
  // from the highest EVER issued for this lever — never from the current claim
  // — so a holder paused past its expiry can never present a fence that
  // matches the new grant.
  const fence = (state.fences[req.lever] ?? 0) + 1;
  const claim: Claim = {
    lever: req.lever,
    holder: req.holder,
    fence,
    acquiredAt: now,
    expiresAt: now + req.ttlMs,
    note: req.note,
  };
  return {
    ok: true,
    renewed: false,
    claim,
    state: {
      claims: { ...state.claims, [req.lever]: claim },
      fences: { ...state.fences, [req.lever]: fence },
    },
  };
}

export function release(
  state: ClaimState,
  req: { lever: string; holder: string; fence: number },
  now: number,
): ReleaseResult {
  const existing = state.claims[req.lever];
  if (!existing || existing.expiresAt <= now) {
    return { ok: false, reason: 'not_held', detail: 'no live claim on that lever' };
  }
  // An agent must never be able to release another's claim — that is the same
  // failure as no locking at all, just harder to see.
  if (existing.holder !== req.holder) {
    return { ok: false, reason: 'not_holder', detail: 'claim is held by another agent' };
  }
  if (existing.fence !== req.fence) {
    return { ok: false, reason: 'stale_fence', detail: 'fence does not match the live grant' };
  }
  const claims = { ...state.claims };
  delete claims[req.lever];
  // `fences` is deliberately NOT cleared: it is the monotonic memory that makes
  // a resumed holder's token detectably stale after a release/re-acquire cycle.
  return { ok: true, state: { claims, fences: state.fences } };
}

/** Drop expired entries so the stored ledger cannot grow without bound. */
export function compact(state: ClaimState, now: number): ClaimState {
  const claims: Record<string, Claim> = {};
  for (const c of activeClaims(state, now)) claims[c.lever] = c;
  return { claims, fences: state.fences };
}
