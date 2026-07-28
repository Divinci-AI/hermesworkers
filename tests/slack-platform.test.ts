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
