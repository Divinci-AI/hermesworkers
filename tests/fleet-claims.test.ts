import { describe, it, expect } from 'vitest';
import {
  acquire, release, activeClaims, compact, emptyState, isValidLever,
  MAX_LEVERS, MIN_TTL_MS, MAX_TTL_MS,
} from '../src/lib/fleet-claims';

const T0 = 1_700_000_000_000;
const TTL = 60_000;
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};

describe('mutual exclusion', () => {
  it('a second agent cannot take a held lever, and is told who holds it', () => {
    const s = ok(acquire(emptyState(), { lever: 'checkout-funnel', holder: 'team', ttlMs: TTL }, T0)).state;
    const r = acquire(s, { lever: 'checkout-funnel', holder: 'delta', ttlMs: TTL }, T0 + 1);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('held');
    if (r.reason !== 'held') return;
    // Naming the holder is the point: a refusal with no holder forces a blind
    // retry loop, which is the dogpile in a different costume.
    expect(r.by).toBe('team');
    expect(r.expiresAt).toBe(T0 + TTL);
  });

  it('different levers do not contend', () => {
    let s = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0)).state;
    s = ok(acquire(s, { lever: 'b', holder: 'delta', ttlMs: TTL }, T0)).state;
    expect(activeClaims(s, T0).map((c) => c.holder)).toEqual(['team', 'delta']);
  });
});

describe('expiry is evaluated at read time', () => {
  it('an expired claim frees the lever with no sweep having run', () => {
    // The whole reason expiry is not a scheduled job: a sweep that fails to
    // run leaves every lever held forever, and a quiet fleet looks healthy.
    const s = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0)).state;
    expect(activeClaims(s, T0 + TTL + 1)).toEqual([]);
    expect(ok(acquire(s, { lever: 'a', holder: 'delta', ttlMs: TTL }, T0 + TTL + 1)).claim.holder)
      .toBe('delta');
  });

  it('a claim is live right up to its expiry and dead at it', () => {
    const s = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0)).state;
    expect(activeClaims(s, T0 + TTL - 1)).toHaveLength(1);
    expect(activeClaims(s, T0 + TTL)).toHaveLength(0);
  });
});

describe('fencing token', () => {
  it('a holder paused past its expiry cannot release the new holder claim', () => {
    // The classic distributed-lock bug: team is paused (container evicted, slow
    // model turn), delta legitimately takes over, team wakes still holding its
    // old grant. Without a fence this release succeeds and silently unlocks a
    // lever delta is actively working.
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const staleFence = a.claim.fence;
    const s = ok(acquire(a.state, { lever: 'a', holder: 'delta', ttlMs: TTL }, T0 + TTL + 1)).state;

    const r = release(s, { lever: 'a', holder: 'team', fence: staleFence }, T0 + TTL + 2);
    expect(r.ok).toBe(false);
    expect(activeClaims(s, T0 + TTL + 2)[0]!.holder).toBe('delta');
  });

  it('fences increase monotonically and never reuse a value after release', () => {
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const s2 = ok(release(a.state, { lever: 'a', holder: 'team', fence: a.claim.fence }, T0 + 1)).state;
    const b = ok(acquire(s2, { lever: 'a', holder: 'team', ttlMs: TTL }, T0 + 2));
    expect(b.claim.fence).toBeGreaterThan(a.claim.fence);
  });

  it('a stale fence is refused even from the correct holder', () => {
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const s2 = ok(release(a.state, { lever: 'a', holder: 'team', fence: a.claim.fence }, T0 + 1)).state;
    const b = ok(acquire(s2, { lever: 'a', holder: 'team', ttlMs: TTL }, T0 + 2));
    const r = release(b.state, { lever: 'a', holder: 'team', fence: a.claim.fence }, T0 + 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('stale_fence');
  });
});

describe('renew', () => {
  it('the current holder re-acquiring extends rather than conflicting', () => {
    // An agent retrying after a network blip must not deadlock against itself:
    // that converts a transient failure into a permanent one.
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const b = ok(acquire(a.state, { lever: 'a', holder: 'team', ttlMs: TTL }, T0 + 100));
    expect(b.renewed).toBe(true);
    expect(b.claim.expiresAt).toBe(T0 + 100 + TTL);
    expect(b.claim.fence).toBe(a.claim.fence); // a renew is not a new grant
    expect(b.claim.acquiredAt).toBe(T0);
  });
});

describe('release', () => {
  it('an agent cannot release another agent claim', () => {
    // Equivalent to no locking at all, just harder to see.
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const r = release(a.state, { lever: 'a', holder: 'delta', fence: a.claim.fence }, T0 + 1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_holder');
  });

  it('releasing an unheld lever is refused, not silently accepted', () => {
    const r = release(emptyState(), { lever: 'a', holder: 'team', fence: 1 }, T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_held');
  });

  it('release frees the lever immediately', () => {
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const s = ok(release(a.state, { lever: 'a', holder: 'team', fence: a.claim.fence }, T0 + 1)).state;
    expect(activeClaims(s, T0 + 2)).toEqual([]);
  });
});

describe('input validation and bounds', () => {
  it('rejects levers that are empty, oversized, or oddly charactered', () => {
    expect(isValidLever('')).toBe(false);
    expect(isValidLever('a'.repeat(121))).toBe(false);
    expect(isValidLever('has space')).toBe(false);
    expect(isValidLever('drop;table')).toBe(false);
    expect(isValidLever('checkout/funnel:step-2.a_B')).toBe(true);
  });

  it('rejects a ttl outside the allowed window', () => {
    for (const ttlMs of [0, MIN_TTL_MS - 1, MAX_TTL_MS + 1, NaN, Infinity]) {
      expect(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs }, T0).ok).toBe(false);
    }
  });

  it('caps active claims so a looping agent cannot grow the ledger forever', () => {
    let s = emptyState();
    for (let i = 0; i < MAX_LEVERS; i++) {
      s = ok(acquire(s, { lever: `l${i}`, holder: 'team', ttlMs: TTL }, T0)).state;
    }
    const r = acquire(s, { lever: 'one-more', holder: 'team', ttlMs: TTL }, T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('capacity');
  });

  it('the cap counts ACTIVE claims, so expiry restores capacity', () => {
    let s = emptyState();
    for (let i = 0; i < MAX_LEVERS; i++) {
      s = ok(acquire(s, { lever: `l${i}`, holder: 'team', ttlMs: TTL }, T0)).state;
    }
    expect(acquire(s, { lever: 'later', holder: 'team', ttlMs: TTL }, T0 + TTL + 1).ok).toBe(true);
  });
});

describe('compaction', () => {
  it('drops expired claims but keeps the fence memory', () => {
    const a = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0));
    const c = compact(a.state, T0 + TTL + 1);
    expect(c.claims).toEqual({});
    // Dropping fences here would let a re-acquired lever re-issue fence 1,
    // exactly matching what a paused holder still carries.
    expect(c.fences.a).toBe(a.claim.fence);
    const next = ok(acquire(c, { lever: 'a', holder: 'delta', ttlMs: TTL }, T0 + TTL + 2));
    expect(next.claim.fence).toBeGreaterThan(a.claim.fence);
  });
});

describe('purity', () => {
  it('acquire and release never mutate the state they are given', () => {
    // The DO persists only on success; a mutating helper would corrupt the
    // ledger on a path that returned an error.
    const s0 = ok(acquire(emptyState(), { lever: 'a', holder: 'team', ttlMs: TTL }, T0)).state;
    const snapshot = JSON.stringify(s0);
    acquire(s0, { lever: 'a', holder: 'delta', ttlMs: TTL }, T0 + 1);
    release(s0, { lever: 'a', holder: 'delta', fence: 1 }, T0 + 1);
    acquire(s0, { lever: 'b', holder: 'delta', ttlMs: TTL }, T0 + 1);
    expect(JSON.stringify(s0)).toBe(snapshot);
  });
});
