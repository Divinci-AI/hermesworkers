import { describe, it, expect } from 'vitest';
import {
  isValidAgentId,
  resolveAgentId,
  checkServiceAuth,
  getContainerForAgent,
} from '../src/lib/tenant';
import type { Env } from '../src/lib/container';

// A mock DurableObjectNamespace recording the names it's asked to resolve, so we
// can assert the routing invariant: distinct agentIds ⇒ distinct DO names.
function mockNamespace() {
  const namesResolved: string[] = [];
  const HERMES = {
    idFromName(name: string) {
      namesResolved.push(name);
      return { __name: name, toString: () => `id(${name})`, equals: (o: any) => o?.__name === name };
    },
    get(id: any) {
      return { __stubFor: id.__name };
    },
  } as unknown as Env['HERMES'];
  return { HERMES, namesResolved };
}

function env(partial: Partial<Env>): Env {
  return { HERMES: {} as Env['HERMES'], ...partial };
}

describe('isValidAgentId', () => {
  it('accepts a uuid-ish lowercase id', () => {
    expect(isValidAgentId('agent-01hzx9k2q3')).toBe(true);
    expect(isValidAgentId('0123abcd-4567-89ef-0123-456789abcdef')).toBe(true);
  });
  it('rejects too-short / too-long', () => {
    expect(isValidAgentId('a1b2c3')).toBe(false); // 6 chars
    expect(isValidAgentId('a'.repeat(65))).toBe(false);
  });
  it('rejects uppercase, spaces, and path/injection chars', () => {
    for (const bad of ['Agent-123456', 'a b c d e f', '../../etc', 'a/b/c/dddd', 'agent:main', 'main']) {
      expect(isValidAgentId(bad)).toBe(false);
    }
  });
  it('rejects leading/trailing hyphen and non-strings', () => {
    expect(isValidAgentId('-abcdefgh')).toBe(false);
    expect(isValidAgentId('abcdefgh-')).toBe(false);
    expect(isValidAgentId(undefined)).toBe(false);
    expect(isValidAgentId(12345678 as unknown)).toBe(false);
  });
});

describe('resolveAgentId', () => {
  it('resolves a valid header', () => {
    expect(resolveAgentId('agent-01hzx9k2q3')).toEqual({ ok: true, agentId: 'agent-01hzx9k2q3' });
  });
  it('400s on missing', () => {
    expect(resolveAgentId(null)).toMatchObject({ ok: false, status: 400, error: 'missing_agent_id' });
  });
  it('400s on invalid', () => {
    expect(resolveAgentId('../evil')).toMatchObject({ ok: false, status: 400, error: 'invalid_agent_id' });
  });
});

describe('checkServiceAuth', () => {
  const secret = 'svc-secret-token';
  const e = env({ SERVICE_AUTH_SECRET: secret });

  it('503s when hosted mode is not configured', async () => {
    const out = await checkServiceAuth(env({}), `Bearer ${secret}`, 'agent-01hzx9k2q3');
    expect(out).toMatchObject({ ok: false, status: 503, error: 'hosted_mode_not_configured' });
  });

  it('401s on a wrong service token (before even reading agent id)', async () => {
    const out = await checkServiceAuth(e, 'Bearer wrong', 'agent-01hzx9k2q3');
    expect(out).toMatchObject({ ok: false, status: 401 });
  });

  it('401s when the token is missing', async () => {
    const out = await checkServiceAuth(e, null, 'agent-01hzx9k2q3');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(401);
  });

  it('400s on a valid token but invalid agent id', async () => {
    const out = await checkServiceAuth(e, `Bearer ${secret}`, 'MAIN');
    expect(out).toMatchObject({ ok: false, status: 400, error: 'invalid_agent_id' });
  });

  it('succeeds with valid token + valid agent id, returning the id', async () => {
    const out = await checkServiceAuth(e, `Bearer ${secret}`, 'agent-01hzx9k2q3');
    expect(out).toMatchObject({ ok: true, agentId: 'agent-01hzx9k2q3' });
  });
});

describe('getContainerForAgent — routing isolation invariant', () => {
  it('resolves two distinct agents to two distinct, namespaced DO names', () => {
    const { HERMES, namesResolved } = mockNamespace();
    const e = env({ HERMES });

    const a = getContainerForAgent(e, 'agent-aaaaaaaa') as any;
    const b = getContainerForAgent(e, 'agent-bbbbbbbb') as any;

    expect(namesResolved).toEqual(['agent:agent-aaaaaaaa', 'agent:agent-bbbbbbbb']);
    expect(a.__stubFor).toBe('agent:agent-aaaaaaaa');
    expect(b.__stubFor).toBe('agent:agent-bbbbbbbb');
    expect(a.__stubFor).not.toBe(b.__stubFor); // different container, always
  });

  it('resolves the same agent to the same DO name every time (sticky)', () => {
    const { HERMES } = mockNamespace();
    const e = env({ HERMES });
    const first = getContainerForAgent(e, 'agent-cccccccc') as any;
    const second = getContainerForAgent(e, 'agent-cccccccc') as any;
    expect(first.__stubFor).toBe(second.__stubFor);
  });

  it('namespaces under `agent:` so no agent can ever collide with the single-tenant `main`', () => {
    const { HERMES, namesResolved } = mockNamespace();
    getContainerForAgent(env({ HERMES }), 'agent-dddddddd');
    expect(namesResolved[0]).toBe('agent:agent-dddddddd');
    expect(namesResolved[0]).not.toBe('main');
  });

  it('THROWS on an invalid agentId — never falls back to a shared container', () => {
    const { HERMES } = mockNamespace();
    const e = env({ HERMES });
    for (const bad of ['../evil', 'MAIN', 'main', 'a/b', 'short']) {
      expect(() => getContainerForAgent(e, bad)).toThrow(/invalid agentId/i);
    }
  });
});


describe('checkServiceAuth — rotation window (SERVICE_AUTH_SECRET_NEXT)', () => {
  const OLD = 'svc-secret-old';
  const NEW = 'svc-secret-new';
  const AGENT = 'agent-01hzx9k2q3';

  it('accepts BOTH secrets while NEXT is set — the whole point', () => {
    // Rotating with only one accepted secret breaks every hosted-Hermes call
    // from the Worker deploy until public-api restarts, because public-api
    // reads Infisical at BOOT. A rotation that costs an outage is a rotation
    // nobody performs, which is how an exposed credential stays live.
    const e = env({ SERVICE_AUTH_SECRET: OLD, SERVICE_AUTH_SECRET_NEXT: NEW });
    return Promise.all([
      checkServiceAuth(e, `Bearer ${OLD}`, AGENT).then((r) => expect(r.ok).toBe(true)),
      checkServiceAuth(e, `Bearer ${NEW}`, AGENT).then((r) => expect(r.ok).toBe(true)),
    ]);
  });

  it('still rejects everything else while NEXT is set', async () => {
    const e = env({ SERVICE_AUTH_SECRET: OLD, SERVICE_AUTH_SECRET_NEXT: NEW });
    expect((await checkServiceAuth(e, 'Bearer neither', AGENT)).ok).toBe(false);
  });

  it('an EMPTY next is not a second credential', async () => {
    // HONEST NOTE ON WHAT THIS DOES AND DOES NOT PIN.
    //
    // Measured, not assumed: removing `next.length > 0` does NOT fail this
    // test, and neither does removing the `if (!provided)` early return. The
    // property is jointly guaranteed a third way — timingSafeEqual never
    // matches an absent or empty bearer against a non-empty secret — so both
    // of those lines are defence-in-depth rather than the thing doing the
    // work. Said plainly because the opposite claim is the tempting one, and a
    // comment asserting a guard is load-bearing when it is not is how the
    // guard gets deleted later by someone who checked.
    //
    // This therefore pins the PROPERTY, not any one line: with NEXT empty or
    // unset, no bearer value authenticates except the primary. That is the
    // thing that must stay true through any refactor of this function.
    for (const next of ['', undefined]) {
      const e = env({ SERVICE_AUTH_SECRET: OLD, SERVICE_AUTH_SECRET_NEXT: next });
      expect((await checkServiceAuth(e, 'Bearer ', AGENT)).ok).toBe(false);
      expect((await checkServiceAuth(e, 'Bearer', AGENT)).ok).toBe(false);
      expect((await checkServiceAuth(e, '', AGENT)).ok).toBe(false);
      for (const bogus of ['Bearer null', 'Bearer undefined', 'Bearer 0', 'null', 'Basic ']) {
        expect((await checkServiceAuth(e, bogus, AGENT)).ok).toBe(false);
      }
      expect((await checkServiceAuth(e, `Bearer ${OLD}`, AGENT)).ok).toBe(true);
    }
  });

  it('NEXT alone cannot authorise when the primary is unset', async () => {
    // Hosted mode is configured by SERVICE_AUTH_SECRET; a deployment carrying
    // only NEXT is misconfigured and must fail closed, not half-open.
    const e = env({ SERVICE_AUTH_SECRET: undefined, SERVICE_AUTH_SECRET_NEXT: NEW });
    expect(await checkServiceAuth(e, `Bearer ${NEW}`, AGENT)).toMatchObject({
      ok: false,
      status: 503,
    });
  });

  it('rotation completes: once NEXT is removed the old secret stops working', async () => {
    const done = env({ SERVICE_AUTH_SECRET: NEW });
    expect((await checkServiceAuth(done, `Bearer ${NEW}`, AGENT)).ok).toBe(true);
    expect((await checkServiceAuth(done, `Bearer ${OLD}`, AGENT)).ok).toBe(false);
  });
});
