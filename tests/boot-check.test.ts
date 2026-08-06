import { describe, it, expect } from 'vitest';
import { BOOT_CHECK_COMMAND, parseBootCheck } from '../src/lib/boot-check';
import { SLACK_ENV_ABSOLUTE } from '../src/lib/slack-platform';

describe('BOOT_CHECK_COMMAND', () => {
  it('probes the same path the Slack apply writes', () => {
    // If these two ever drift, the sweep re-pushes Slack config on every tick
    // against a container that already has it — a restart loop that presents as
    // "the bot keeps dropping mid-conversation".
    expect(BOOT_CHECK_COMMAND).toContain(SLACK_ENV_ABSOLUTE);
  });

  it('tests for a NON-EMPTY file, so a truncated write reads as missing', () => {
    expect(BOOT_CHECK_COMMAND).toContain(`[ -s '${SLACK_ENV_ABSOLUTE}' ]`);
  });

  it('never READS the file — it holds Slack bot and app tokens', () => {
    // Scoped to the Slack path deliberately: `head -1` elsewhere in the probe
    // is a legitimate part of the pgrep pipeline. What must never appear is a
    // read command pointed at slack.env, whose contents would then land in the
    // boot-check response and in every caller's logs.
    for (const reader of ['cat', 'base64', 'head', 'tail', 'grep', 'sed', 'awk', 'od', 'xxd']) {
      expect(BOOT_CHECK_COMMAND).not.toMatch(
        new RegExp(`\\b${reader}\\b[^;]*${SLACK_ENV_ABSOLUTE.replace(/[.]/g, '\\.')}`),
      );
    }
    // The only operator applied to that path is a test for existence.
    expect(BOOT_CHECK_COMMAND.match(new RegExp(SLACK_ENV_ABSOLUTE, 'g'))).toHaveLength(1);
  });
});

describe('parseBootCheck', () => {
  it('reads both facts out of one probe', () => {
    const f = parseBootCheck('gateway_user=hermes\nslack_env=present\n');
    expect(f).toEqual({ gatewayUser: 'hermes', nonRoot: true, slackEnvPresent: true });
  });

  it('flags a gateway still running as root', () => {
    expect(parseBootCheck('gateway_user=root\nslack_env=missing').nonRoot).toBe(false);
  });

  it('reports a container that lost its Slack config', () => {
    // The whole point of the field: the gateway is healthy, and Slack is gone.
    const f = parseBootCheck('gateway_user=hermes\nslack_env=missing');
    expect(f.nonRoot).toBe(true);
    expect(f.slackEnvPresent).toBe(false);
  });

  it('returns undefined — NOT false — when the probe says nothing about Slack', () => {
    // An older deployed Worker answers without the slack_env line. Reading that
    // as "missing" would make the sweep re-push Slack config forever against a
    // Worker that is fine.
    expect(parseBootCheck('gateway_user=hermes').slackEnvPresent).toBeUndefined();
    expect(parseBootCheck('').slackEnvPresent).toBeUndefined();
    expect(parseBootCheck(undefined).slackEnvPresent).toBeUndefined();
  });

  it('treats a garbled answer as no answer rather than guessing', () => {
    expect(parseBootCheck('gateway_user=hermes\nslack_env=???').slackEnvPresent).toBeUndefined();
  });
});
