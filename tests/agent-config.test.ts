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
    expect(sh).toContain('hermes config set model.default "$MODEL_LEAF"');
  });

  // gap: the config route is start-hermes.sh's TWIN and was fixed twice behind
  // it. On 2026-08-25 it wrote the PREFIXED id into model.default and never set
  // model.provider, so restoring a pin after an evict produced a config the
  // gateway could not route — `AiError: No such model: cfai/@cf/…` — and took
  // two of three production agents down while "restoring" them.
  it('splits the provider out, like the boot script does', () => {
    const sh = buildAgentConfigShell({ model: 'cfai/@cf/deepseek-ai/deepseek-v4-pro-0813' });
    expect(sh).toContain('MODEL_PROVIDER="${MODEL_ID%%/*}"');
    expect(sh).toContain('hermes config set model.provider "$MODEL_PROVIDER"');
    // never the prefixed id straight into default
    expect(sh).not.toContain("model.default 'cfai/@cf/deepseek-ai/deepseek-v4-pro-0813'");
  });

  it('guards the no-slash case so a bare id is not mangled', () => {
    const sh = buildAgentConfigShell({ model: 'gemini-2.5-flash' });
    expect(sh).toContain('MODEL_PROVIDER=""; MODEL_LEAF="$MODEL_ID"');
  });

  // gap: hermes-config-set-model-failure-is-swallowed-and-then-misreported
  //
  // `model` is a MAPPING in config.yaml (default / provider / base_url).
  // Writing a scalar over it is rejected by the PINNED container CLI
  // (HERMES_VERSION=v2026.7.7.2); newer CLIs silently redirect bare `model` to
  // `model.default`, which is why this read as correct in every by-hand test
  // and failed only in production.
  it('sets model.default, never bare model', () => {
    const sh = buildAgentConfigShell({ model: 'gemini-2.5-flash' });
    expect(sh).not.toMatch(/hermes config set model\s+'/);
  });

  // The rejection was invisible twice over, and the second half is the one
  // that mattered: `2>/dev/null` dropped the reason, `|| true` dropped the
  // exit code, and `model_set=` then echoed the REQUESTED value regardless —
  // so the caller could not tell "stored" from "rejected". A report that
  // restates its own input cannot detect this class of failure.
  it('reports what the config HOLDS, not what was requested', () => {
    const sh = buildAgentConfigShell({ model: 'gemini-2.5-flash' });
    expect(sh).toContain('model_stored=');
    // ⚠️ `hermes config get` does not exist on the pinned CLI; this line
    // logged argparse usage text as the value until 2026-08-25.
    expect(sh).not.toContain('hermes config get');
    expect(sh).toContain('.hermes/config.yaml');
    // Scoped to the model line on purpose: the trailing `chown … || true` is
    // legitimately best-effort, and asserting over the whole script would
    // couple this test to that unrelated line.
    const modelLine = sh.split('\n').find((l) => l.includes('hermes config set model'))!;
    expect(modelLine).not.toContain('2>/dev/null');
    expect(modelLine).not.toContain('|| true');
  });

  it('always hands ownership back to the hermes uid', () => {
    // The exec runs as root; leaving root-owned files under ~/.hermes would
    // break the non-root gateway that has to read them.
    expect(buildAgentConfigShell({ model: 'x' })).toContain('chown -R hermes:hermes');
  });
});
