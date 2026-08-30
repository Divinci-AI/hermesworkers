/**
 * FleetCoordinator — one Durable Object per fleet, holding the claim ledger.
 *
 * The DO is the whole reason the logic in lib/fleet-claims.ts is safe: a DO
 * serializes requests for a given id, so the read-modify-write below is atomic
 * without any locking of our own. Do NOT reimplement this over KV or R2. A
 * previous claim ledger in this codebase did exactly that and R2's `list()` is
 * eventually consistent, so it failed in both directions at once — duplicate
 * launches AND starvation. Mutual exclusion cannot be built on an
 * eventually-consistent read.
 *
 * All state lives under one storage key: the ledger is small (bounded at
 * MAX_LEVERS), and a single key means the persist is one atomic write rather
 * than a multi-key update that could tear.
 */
import {
  acquire,
  activeClaims,
  compact,
  emptyState,
  release,
  type ClaimState,
} from './lib/fleet-claims';

const KEY = 'claims:v1';

export class FleetCoordinator {
  private ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  private async load(): Promise<ClaimState> {
    const stored = await this.ctx.storage.get<ClaimState>(KEY);
    if (!stored || typeof stored !== 'object' || !stored.claims) return emptyState();
    return { claims: stored.claims ?? {}, fences: stored.fences ?? {} };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    // GET — the board. Every agent reads this before deciding what to work on.
    if (request.method === 'GET') {
      const state = await this.load();
      return json({ ok: true, now, claims: activeClaims(state, now) });
    }

    if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return json({ ok: false, error: 'invalid json' }, 400);
    }

    const state = await this.load();

    if (url.pathname.endsWith('/acquire')) {
      const r = acquire(
        state,
        {
          lever: String(body.lever ?? ''),
          holder: String(body.holder ?? ''),
          ttlMs: Number(body.ttlMs ?? 0),
          note: body.note === undefined ? undefined : String(body.note),
        },
        now,
      );
      if (!r.ok) {
        // 409 for a live conflict — a caller should pick a different lever, not
        // retry. 400 for a malformed request, which retrying cannot fix.
        const status = r.reason === 'held' ? 409 : r.reason === 'capacity' ? 429 : 400;
        return json(r, status);
      }
      // Compact on write: the only path that grows the ledger is also the one
      // that trims it, so no scheduled sweep is required to bound it.
      await this.ctx.storage.put(KEY, compact(r.state, now));
      return json({ ok: true, renewed: r.renewed, claim: r.claim });
    }

    if (url.pathname.endsWith('/release')) {
      const r = release(
        state,
        {
          lever: String(body.lever ?? ''),
          holder: String(body.holder ?? ''),
          fence: Number(body.fence ?? -1),
        },
        now,
      );
      if (!r.ok) return json(r, r.reason === 'not_held' ? 404 : 409);
      await this.ctx.storage.put(KEY, compact(r.state, now));
      return json({ ok: true });
    }

    return json({ ok: false, error: 'not found' }, 404);
  }
}
