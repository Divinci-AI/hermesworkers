import { describe, it, expect } from 'vitest';
import {
  timingSafeEqual,
  extractBearer,
  extractCookieToken,
  checkAuth,
} from '../src/lib/auth';
import type { Env } from '../src/lib/container';

// Minimal Env factory — only the fields the auth path reads.
function env(partial: Partial<Env>): Env {
  return { HERMES: {} as Env['HERMES'], ...partial };
}

describe('timingSafeEqual', () => {
  it('returns true for identical strings', async () => {
    expect(await timingSafeEqual('s3cret-token', 's3cret-token')).toBe(true);
  });

  it('returns false for different strings', async () => {
    expect(await timingSafeEqual('s3cret-token', 's3cret-tokeX')).toBe(false);
  });

  it('returns false for different-length strings (no length leak / no crash)', async () => {
    expect(await timingSafeEqual('short', 'a-much-longer-value')).toBe(false);
  });

  it('returns false when one side is empty', async () => {
    expect(await timingSafeEqual('', 'token')).toBe(false);
  });
});

describe('extractBearer', () => {
  it('parses a well-formed bearer header', () => {
    expect(extractBearer('Bearer abc123')).toBe('abc123');
  });
  it('trims surrounding whitespace', () => {
    expect(extractBearer('Bearer   abc123  ')).toBe('abc123');
  });
  it('ignores non-bearer schemes', () => {
    expect(extractBearer('Basic abc123')).toBe('');
  });
  it('handles null / missing header', () => {
    expect(extractBearer(null)).toBe('');
  });
});

describe('extractCookieToken', () => {
  it('extracts hw_token from a cookie jar', () => {
    expect(extractCookieToken('foo=1; hw_token=deadbeef; bar=2')).toBe('deadbeef');
  });
  it('url-decodes the value', () => {
    expect(extractCookieToken('hw_token=a%2Bb')).toBe('a+b');
  });
  it('does not match a suffix like xhw_token', () => {
    expect(extractCookieToken('xhw_token=nope')).toBe('');
  });
  it('returns empty when absent', () => {
    expect(extractCookieToken('other=1')).toBe('');
  });
});

describe('checkAuth — fail-closed semantics', () => {
  it('503s when no token is configured and open mode is off', async () => {
    const out = await checkAuth(env({}), 'anything', 'chat');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(503);
    expect(out.body?.error).toBe('server_misconfigured');
  });

  it('allows through when ALLOW_UNAUTHENTICATED=true and no token set', async () => {
    const out = await checkAuth(env({ ALLOW_UNAUTHENTICATED: 'true' }), '', 'chat');
    expect(out.ok).toBe(true);
  });
});

describe('checkAuth — chat level', () => {
  const e = env({ API_TOKEN: 'chat-tok' });

  it('accepts the correct chat token', async () => {
    expect((await checkAuth(e, 'chat-tok', 'chat')).ok).toBe(true);
  });
  it('rejects a wrong token with 401', async () => {
    const out = await checkAuth(e, 'nope', 'chat');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(401);
  });
  it('rejects an empty token with 401', async () => {
    expect((await checkAuth(e, '', 'chat')).ok).toBe(false);
  });
});

describe('checkAuth — privilege separation', () => {
  const e = env({ API_TOKEN: 'chat-tok', ADMIN_TOKEN: 'admin-tok' });

  it('admin token satisfies admin level', async () => {
    expect((await checkAuth(e, 'admin-tok', 'admin')).ok).toBe(true);
  });

  it('chat token is REJECTED at admin level (core separation guarantee)', async () => {
    const out = await checkAuth(e, 'chat-tok', 'admin');
    expect(out.ok).toBe(false);
    expect(out.status).toBe(401);
  });

  it('admin token can also chat (privilege escalation is allowed downward)', async () => {
    expect((await checkAuth(e, 'admin-tok', 'chat')).ok).toBe(true);
  });

  it('chat token still works at chat level', async () => {
    expect((await checkAuth(e, 'chat-tok', 'chat')).ok).toBe(true);
  });
});

describe('checkAuth — admin falls back to API_TOKEN when ADMIN_TOKEN unset', () => {
  const e = env({ API_TOKEN: 'only-tok' });
  it('accepts API_TOKEN at admin level', async () => {
    expect((await checkAuth(e, 'only-tok', 'admin')).ok).toBe(true);
  });
  it('rejects a wrong token at admin level', async () => {
    expect((await checkAuth(e, 'wrong', 'admin')).ok).toBe(false);
  });
});
