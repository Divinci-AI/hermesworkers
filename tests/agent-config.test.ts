import { describe, it, expect } from 'vitest';
import {
  parseAgentConfigBody,
  buildAgentConfigShell,
  SOUL_ABSOLUTE,
  AGENT_MODEL_ENV_ABSOLUTE,
} from '../src/lib/agent-config';

describe('parseAgentConfigBody', () => {
  it('rejects non-objects and empty bodies', () => {
    expect(parseAgentConfigBody(null).ok).toBe(false);
    expect(parseAgentConfigBody('nope').ok).toBe(false);
    expect(parseAgentConfigBody({}).ok).toBe(false);
  });

  it('accepts either field alone', () => {
    expect(parseAgentConfigBody({ systemPrompt: 'hi' }).ok).toBe(true);
    expect(parseAgentConfigBody({ model: 'gemini-2.5-flash' }).ok).toBe(true);
  });

  it('rejects a model that could break out of the shell quoting', () => {
    expect(parseAgentConfigBody({ model: "x'; rm -rf /; echo '" }).ok).toBe(false);
    expect(parseAgentConfigBody({ model: 'has space' }).ok).toBe(false);
  });

  it('bounds the persona so it cannot fill the container disk', () => {
    expect(parseAgentConfigBody({ systemPrompt: 'a'.repeat(20_001) }).ok).toBe(false);
    expect(parseAgentConfigBody({ systemPrompt: 'a'.repeat(20_000) }).ok).toBe(true);
  });
});

describe('buildAgentConfigShell', () => {
  it('base64-encodes the persona so quotes and newlines cannot break the write', () => {
    const sh = buildAgentConfigShell({ systemPrompt: "it's \"quoted\"\nand `backticked`" });
    expect(sh).not.toContain('backticked');
    expect(sh).toContain('base64 -d');
    expect(sh).toContain(SOUL_ABSOLUTE);
  });

  it('clears the persona by removing SOUL.md, so Hermes falls back to its own identity', () => {
    const sh = buildAgentConfigShell({ systemPrompt: '' });
    expect(sh).toContain(`rm -f '${SOUL_ABSOLUTE}'`);
    expect(sh).toContain('soul_cleared=1');
  });

  it('writes a durable model pin AND applies it live', () => {
    const sh = buildAgentConfigShell({ model: 'gemini-2.5-flash' });
    expect(sh).toContain(AGENT_MODEL_ENV_ABSOLUTE);
    expect(sh).toContain("hermes config set model 'gemini-2.5-flash'");
  });

  it('always hands ownership back to the hermes uid', () => {
    // The exec runs as root; leaving root-owned files under ~/.hermes would
    // break the non-root gateway that has to read them.
    expect(buildAgentConfigShell({ model: 'x' })).toContain('chown -R hermes:hermes');
  });
});
