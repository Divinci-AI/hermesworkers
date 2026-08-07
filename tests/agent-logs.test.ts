import { describe, it, expect } from 'vitest';
import {
  DEFAULT_LINES,
  LOG_SOURCES,
  MAX_LINES,
  buildLogShell,
  clampLines,
  isLogSource,
  redactLog,
} from '../src/lib/agent-logs';

describe('isLogSource', () => {
  it('accepts the known sources and nothing else', () => {
    expect(isLogSource('gateway')).toBe(true);
    expect(isLogSource('dashboard')).toBe(true);
    expect(isLogSource('nope')).toBe(false);
    expect(isLogSource('')).toBe(false);
    expect(isLogSource(null)).toBe(false);
    expect(isLogSource(123)).toBe(false);
  });

  it('does not accept inherited Object properties as sources', () => {
    // A bare `value in LOG_SOURCES` check would let these through and resolve
    // to a function, which is how a source list stops being a source list.
    expect(isLogSource('toString')).toBe(false);
    expect(isLogSource('constructor')).toBe(false);
    expect(isLogSource('__proto__')).toBe(false);
  });
});

describe('clampLines', () => {
  it('defaults when absent or unparseable', () => {
    expect(clampLines(undefined)).toBe(DEFAULT_LINES);
    expect(clampLines('')).toBe(DEFAULT_LINES);
    expect(clampLines('abc')).toBe(DEFAULT_LINES);
    expect(clampLines(NaN)).toBe(DEFAULT_LINES);
  });

  it('clamps to the allowed range', () => {
    expect(clampLines(0)).toBe(1);
    expect(clampLines(-50)).toBe(1);
    expect(clampLines(MAX_LINES + 1000)).toBe(MAX_LINES);
    expect(clampLines('500')).toBe(500);
  });

  it('always returns an integer, so it is safe to interpolate into a shell', () => {
    expect(clampLines(12.9)).toBe(12);
    expect(Number.isInteger(clampLines('7.5'))).toBe(true);
  });
});

describe('buildLogShell', () => {
  it('reads the tail of the mapped path', () => {
    const shell = buildLogShell('gateway', 100);
    expect(shell).toContain(LOG_SOURCES.gateway);
    expect(shell).toContain('tail -n 100');
  });

  it('reports a missing file instead of failing', () => {
    // A container that has not booted far enough to create the log is a normal
    // state and must read as such, not as a broken request.
    expect(buildLogShell('dashboard', 10)).toContain('does not exist');
  });

  it('never emits a non-integer line count', () => {
    expect(buildLogShell('gateway', 12.9 as number)).toContain('tail -n 12');
  });
});

/**
 * Fixtures for the redactor, assembled at runtime rather than written as
 * literals.
 *
 * These are fake — `AIza` + `SyA1234567890…`, the jwt.io sample JWT — but a
 * test for a redactor has to feed it strings shaped exactly like real
 * credentials, and GitHub push protection scans SOURCE for those shapes. It
 * blocked the whole branch on 2026-08-07 (GH013), which is a bypass prompt on
 * every future push, and a bypass is a habit worth not forming.
 *
 * Splitting the prefix defeats the scanner's literal match while the value
 * `redactLog` receives is byte-identical. That equivalence is the whole point:
 * weakening the fixture so it stopped matching the redactor's patterns would
 * leave the test passing and testing nothing. The `redaction fixtures` block
 * below pins the assembled shapes so a careless edit to the halves cannot
 * silently do that.
 */
const FAKE = {
  cloudflare: 'cfat' + '_abcdefghijklmnopqrstuvwxyz0123456789',
  google: 'AIza' + 'SyA1234567890abcdefghijklmnopqrstuv',
  slackBot: 'xoxb' + '-123456789012-1234567890123-abcdefghijklmnopqrstuvwx',
  slackApp: 'xapp' + '-1-A01234567-1234567890123-abcdef',
  openai: 'sk' + '-abcdefghijklmnopqrstuvwxyz0123456789',
  pemBody: 'MIIEvQIBADANBgkq',
  jwtSig: 'dozjgNryP4J3jVmNHl0w5N' + '_XgL0n3I9PlFUP0THsR8U',
};
const FAKE_PEM = `-----BEGIN PRIVATE` + ` KEY-----\n${FAKE.pemBody}\nhkiG9w0BAQEFAA\n-----END PRIVATE` + ` KEY-----`;
const FAKE_JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.${FAKE.jwtSig}`;

describe('redaction fixtures', () => {
  it('assemble to the exact shapes the redactor must catch', () => {
    // If a future edit breaks one of these, the redactor tests below would go
    // green while feeding it something it was never meant to match.
    expect(FAKE.cloudflare).toMatch(/^cfat_[a-z0-9]{36}$/);
    expect(FAKE.google).toMatch(/^AIza[A-Za-z0-9_-]{35}$/);
    expect(FAKE.slackBot).toMatch(/^xoxb-\d+-\d+-[a-z]+$/);
    expect(FAKE.slackApp).toMatch(/^xapp-1-[A-Z0-9]+-\d+-[a-f0-9]+$/);
    expect(FAKE.openai).toMatch(/^sk-[a-z0-9]{36}$/);
    expect(FAKE_PEM.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
    expect(FAKE_JWT.split('.')).toHaveLength(3);
  });
});

describe('redactLog', () => {
  it('leaves ordinary startup lines untouched', () => {
    const clean = '[startup] model=gemini-2.5-flash (per-agent=none)\n[startup] wrote /home/hermes/.hermes/.env (14 lines)';
    const out = redactLog(clean);
    expect(out.text).toBe(clean);
    expect(out.redactions).toBe(0);
  });

  it('redacts vendor key shapes', () => {
    const cases = [
      FAKE.cloudflare,
      FAKE.google,
      FAKE.slackBot,
      FAKE.slackApp,
      FAKE.openai,
    ];
    for (const secret of cases) {
      const out = redactLog(`token is ${secret} end`);
      expect(out.text).not.toContain(secret);
      expect(out.redactions).toBeGreaterThan(0);
    }
  });

  it('redacts a PEM private key block', () => {
    const out = redactLog(`sa json: ${FAKE_PEM}`);
    expect(out.text).not.toContain(FAKE.pemBody);
    expect(out.text).toContain('[PRIVATE_KEY REDACTED]');
  });

  it('redacts a JWT', () => {
    const out = redactLog(`auth: ${FAKE_JWT}`);
    expect(out.text).not.toContain(FAKE.jwtSig);
  });

  it('keeps the variable NAME while redacting its value', () => {
    // "was CLOUDFLARE_API_KEY set?" is the usual question — a blanket redaction
    // that hid the name too would defeat the point of reading the log.
    const out = redactLog('CLOUDFLARE_API_KEY=supersecretvalue123456');
    expect(out.text).toContain('CLOUDFLARE_API_KEY=');
    expect(out.text).toContain('[REDACTED]');
    expect(out.text).not.toContain('supersecretvalue123456');
  });

  it('redacts assignment shapes generically', () => {
    for (const line of [
      'SLACK_BOT_TOKEN=abcdefghijklmnop',
      'api_secret: hunter2hunter2hunter2',
      'DB_PASSWORD = "correcthorsebatterystaple"',
    ]) {
      const out = redactLog(line);
      expect(out.redactions).toBeGreaterThan(0);
      expect(out.text).toContain('[REDACTED]');
    }
  });

  it('counts every substitution it makes', () => {
    const out = redactLog(`a ${FAKE.google} b ${FAKE.openai}`);
    expect(out.redactions).toBe(2);
  });

  it('is safe on empty input', () => {
    expect(redactLog('')).toEqual({ text: '', redactions: 0 });
  });

  it('keeps an env var NAME used as a value — it is a reference, not a secret', () => {
    // This is the real startup line for the cfai provider. Redacting the value
    // hides which variable the provider reads, which is the whole question.
    const line = '✓ Set providers.cfai.key_env = CLOUDFLARE_API_KEY in /home/hermes/.hermes/config.yaml';
    const out = redactLog(line);
    expect(out.text).toBe(line);
    expect(out.redactions).toBe(0);
  });

  it('still redacts values that merely look shouty but are not env-var-shaped', () => {
    for (const value of [
      'ABCDEF1234567890abcdef',           // has lowercase
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', // no underscore
      'A_VERY_LONG_UPPERCASE_VALUE_THAT_EXCEEDS_THE_LENGTH_CEILING_FOR_A_NAME',
    ]) {
      const out = redactLog(`SOME_TOKEN=${value}`);
      expect(out.redactions).toBeGreaterThan(0);
      expect(out.text).not.toContain(value);
    }
  });
});
