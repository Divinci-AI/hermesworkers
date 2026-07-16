/**
 * Authentication, authorization and rate-limiting helpers.
 *
 * Design goals (hardened over the v0.1 single-token model):
 *   - Fail closed. If no credential is configured the Worker refuses protected
 *     routes with 503 instead of silently serving an open endpoint. Operators
 *     opt into an open Worker explicitly with `ALLOW_UNAUTHENTICATED=true`.
 *   - Two privilege levels. `chat` gates inference (`/v1/*`, wake, health);
 *     `admin` gates destructive/introspective control (restart, stop, logs).
 *     A holder of the chat token cannot restart or read logs.
 *   - Constant-time comparison. Tokens are compared via SHA-256 digests so the
 *     match loop is fixed-length and leaks neither the token nor its length.
 *   - Optional per-client rate limiting via Cloudflare's native rate-limit
 *     bindings; a no-op when the bindings are absent (local dev).
 */

import type { Env } from './container';
import type { Context } from 'hono';

export type AuthLevel = 'chat' | 'admin';

/**
 * Constant-time string equality. Both inputs are hashed to a fixed-length
 * digest first, so the comparison loop runs in time independent of the inputs'
 * contents *and* length. Uses only the WebCrypto API available in Workers.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Extract a bearer token from the Authorization header, or '' if absent. */
export function extractBearer(header: string | null): string {
  const h = header || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

/** Extract the dashboard session token from the `hw_token` cookie, or ''. */
export function extractCookieToken(cookieHeader: string | null): string {
  const match = (cookieHeader || '').match(/(?:^|;\s*)hw_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/**
 * The set of secrets that satisfy a given privilege level.
 *
 *   - admin: only ADMIN_TOKEN (falls back to API_TOKEN when ADMIN_TOKEN is
 *            unset, so single-token deployments keep working).
 *   - chat:  API_TOKEN, and the ADMIN_TOKEN too (admins may also chat).
 */
function acceptedTokens(env: Env, level: AuthLevel): string[] {
  const chat = env.API_TOKEN;
  const admin = env.ADMIN_TOKEN;
  const list =
    level === 'admin' ? [admin ?? chat] : [chat, admin];
  return list.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

export interface AuthOutcome {
  ok: boolean;
  status?: number;
  body?: { error: string; message?: string };
}

/**
 * Authorize a raw request at the given privilege level. Pure with respect to
 * the request/env (no side effects), so it is unit-testable directly.
 */
export async function checkAuth(
  env: Env,
  provided: string,
  level: AuthLevel,
): Promise<AuthOutcome> {
  const accepted = acceptedTokens(env, level);

  if (accepted.length === 0) {
    if (env.ALLOW_UNAUTHENTICATED === 'true') return { ok: true };
    return {
      ok: false,
      status: 503,
      body: {
        error: 'server_misconfigured',
        message:
          level === 'admin'
            ? 'Set ADMIN_TOKEN (or API_TOKEN) via `wrangler secret put` to enable control endpoints, or set ALLOW_UNAUTHENTICATED=true for local dev.'
            : 'Set API_TOKEN via `wrangler secret put` to enable this Worker, or set ALLOW_UNAUTHENTICATED=true for local dev.',
      },
    };
  }

  if (!provided) return { ok: false, status: 401, body: { error: 'unauthorized' } };

  // Compare against every accepted token in constant time; never short-circuit
  // on the first match in a way that reveals which token matched.
  let matched = false;
  for (const token of accepted) {
    if (await timingSafeEqual(provided, token)) matched = true;
  }
  if (!matched) return { ok: false, status: 401, body: { error: 'unauthorized' } };
  return { ok: true };
}

/** Hono middleware factory enforcing a privilege level on a route group. */
export function authMiddleware(level: AuthLevel) {
  return async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    const provided =
      extractBearer(c.req.header('authorization') ?? null) ||
      extractCookieToken(c.req.header('cookie') ?? null);
    const outcome = await checkAuth(c.env, provided, level);
    if (!outcome.ok) {
      return c.json(outcome.body ?? { error: 'unauthorized' }, (outcome.status ?? 401) as 401 | 503);
    }
    return next();
  };
}

// ─── Rate limiting ──────────────────────────────────────────────────

/**
 * Cloudflare's native rate-limit binding shape. Declared locally so the code
 * type-checks without depending on the (still-unstable) binding types.
 */
export interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** A stable per-client key: the connecting IP, falling back to a constant. */
export function clientKey(c: Context<{ Bindings: Env }>): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for') ||
    'unknown'
  );
}

/**
 * Hono middleware enforcing an optional rate-limit binding. When the binding is
 * absent (e.g. local dev, or an operator who hasn't provisioned it) it is a
 * no-op, so rate limiting is defense-in-depth rather than a hard dependency.
 */
export function rateLimitMiddleware(level: AuthLevel) {
  return async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    const limiter =
      level === 'admin' ? c.env.ADMIN_RATE_LIMITER : c.env.CHAT_RATE_LIMITER;
    if (!limiter) return next();
    const { success } = await limiter.limit({ key: `${level}:${clientKey(c)}` });
    if (!success) {
      return c.json(
        { error: 'rate_limited', message: 'Too many requests. Retry shortly.' },
        429,
      );
    }
    return next();
  };
}
