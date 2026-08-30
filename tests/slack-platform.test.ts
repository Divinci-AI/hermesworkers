import { describe, it, expect } from 'vitest';
import {
  parseSlackApplyBody,
  buildSlackEnvFile,
  buildSlackApplyShell,
  SLACK_ENV_ABSOLUTE,
} from '../src/lib/slack-platform';

describe('parseSlackApplyBody', () => {
  it('rejects non-objects and missing enabled', () => {
    expect(parseSlackApplyBody(null).ok).toBe(false);
    expect(parseSlackApplyBody({}).ok).toBe(false);
  });

  it('accepts disable without tokens', () => {
    const r = parseSlackApplyBody({ enabled: false });
    expect(r).toEqual({
      ok: true,
      body: expect.objectContaining({ enabled: false, allowedUsers: '', allowedChannels: '' }),
    });
  });

  it('requires xoxb + xapp when enabled', () => {
    expect(
      parseSlackApplyBody({ enabled: true, botToken: 'xoxb-ok', appToken: 'bad' }).ok,
    ).toBe(false);
    expect(
      parseSlackApplyBody({
        enabled: true,
        botToken: 'xoxb-test-token',
        appToken: 'xapp-test-token',
        allowedUsers: 'U01OWNER',
        allowedChannels: 'G01PRIVATE',
      }).ok,
    ).toBe(true);
  });
});

describe('buildSlackEnvFile', () => {
  it('returns null when disabled', () => {
    expect(buildSlackEnvFile({ enabled: false })).toBeNull();
  });

  it('writes SLACK_* lines including private channel allowlist', () => {
    const file = buildSlackEnvFile({
      enabled: true,
      botToken: 'xoxb-bot',
      appToken: 'xapp-app',
      allowedUsers: 'U01A,U02B',
      allowedChannels: 'G01PRIVATE,C01PUBLIC',
      freeResponseChannels: 'G01PRIVATE',
      homeChannel: 'G01PRIVATE',
      homeChannelName: 'ops-private',
    });
    expect(file).toContain('SLACK_BOT_TOKEN=xoxb-bot');
    expect(file).toContain('SLACK_APP_TOKEN=xapp-app');
    expect(file).toContain('SLACK_ALLOWED_USERS=U01A,U02B');
    expect(file).toContain('SLACK_ALLOWED_CHANNELS=G01PRIVATE,C01PUBLIC');
    expect(file).toContain('SLACK_FREE_RESPONSE_CHANNELS=G01PRIVATE');
    expect(file).toContain('SLACK_HOME_CHANNEL=G01PRIVATE');
    expect(file).toContain('SLACK_HOME_CHANNEL_NAME=ops-private');
  });
});

describe('allowAllUsers (open-workspace access)', () => {
  const tokens = { enabled: true as const, botToken: 'xoxb-x', appToken: 'xapp-x' };

  it('omits SLACK_ALLOW_ALL_USERS unless explicitly true', () => {
    expect(buildSlackEnvFile({ ...tokens })).not.toContain('SLACK_ALLOW_ALL_USERS');
    expect(buildSlackEnvFile({ ...tokens, allowAllUsers: false })).not.toContain(
      'SLACK_ALLOW_ALL_USERS',
    );
  });

  it('writes SLACK_ALLOW_ALL_USERS=true when set', () => {
    expect(buildSlackEnvFile({ ...tokens, allowAllUsers: true })).toContain(
      'SLACK_ALLOW_ALL_USERS=true',
    );
  });

  it('only accepts a real boolean — a truthy string must not open the workspace', () => {
    const parsed = parseSlackApplyBody({ ...tokens, allowAllUsers: 'true' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body.allowAllUsers).toBe(false);
    expect(buildSlackEnvFile(parsed.body)).not.toContain('SLACK_ALLOW_ALL_USERS');
  });
});

describe('buildSlackApplyShell', () => {
  it('disables by removing the durable file', () => {
    const sh = buildSlackApplyShell({ enabled: false });
    expect(sh).toContain('rm -f');
    expect(sh).toContain(SLACK_ENV_ABSOLUTE);
    expect(sh).toContain('slack_disabled=1');
    expect(sh).not.toContain('xoxb-');
  });

  it('base64-encodes secrets so shell metacharacters cannot break the write', () => {
    const sh = buildSlackApplyShell({
      enabled: true,
      botToken: "xoxb-token-with-'quotes'",
      appToken: 'xapp-token;rm -rf /',
      allowedUsers: 'U01',
      allowedChannels: 'G01PRIVATE',
    });
    // Raw token must not appear unencoded in the shell script.
    expect(sh).not.toContain("xoxb-token-with-'quotes'");
    expect(sh).not.toContain('xapp-token;rm -rf /');
    expect(sh).toContain('base64 -d');
    expect(sh).toContain(SLACK_ENV_ABSOLUTE);
    expect(sh).toContain('slack_enabled=1');
  });
});

describe('bot-loop guard: allow_bots + require_mention', () => {
  // Three Hermes bots share #hermes as of 2026-08-29 (Local, Team, Sigma) and
  // Local runs `slack.allow_bots: all`. Only require_mention prevents every
  // agent answering every other agent forever. These pin that the provisioner
  // cannot ship the dangerous pair.
  const script = (over: Record<string, unknown>) =>
    buildSlackApplyShell({
      enabled: true,
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      allowedUsers: '',
      allowedChannels: '',
      ...over,
    } as never);

  it('pins allow_bots off when mentions are not required', () => {
    const s = script({ requireMention: false });
    expect(s).toContain('slack.require_mention false');
    expect(s).toContain('slack.allow_bots none');
  });

  it('leaves allow_bots alone when mentions ARE required', () => {
    // require_mention:true is the thing that makes allow_bots:all safe, so a
    // deliberate `all` on one instance must survive provisioning.
    const s = script({ requireMention: true });
    expect(s).toContain('slack.require_mention true');
    expect(s).not.toContain('allow_bots');
  });

  it('defaults to the safe side when requireMention is omitted', () => {
    const s = script({});
    expect(s).toContain('slack.require_mention true');
  });

  it('never emits allow_bots all', () => {
    for (const rm of [true, false, undefined]) {
      expect(script({ requireMention: rm })).not.toContain('allow_bots all');
    }
  });
});
