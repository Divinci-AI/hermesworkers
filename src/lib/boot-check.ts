/**
 * Boot-check probe: what one exec tells us about a container's health.
 *
 * Two facts, one round trip:
 *
 *  - `gateway_user` — which uid the Hermes gateway is running as. `root` means
 *    the gosu drop in start-hermes.sh did not take.
 *  - `slack_env`    — whether the durable Slack env file exists.
 *
 * The Slack half is here rather than on a route of its own because the
 * container's disk is the ONLY record of an agent's Slack config: the Worker
 * writes `slack.env` and keeps no copy. A container replacement (any image
 * deploy) therefore drops Slack Socket Mode while leaving the gateway looking
 * perfectly healthy — no error, no log line, the bot just stops answering.
 *
 * Reporting presence is what makes that recoverable rather than invisible.
 * Divinci still holds the tokens encrypted in Mongo and re-pushes when this
 * says `missing`.
 *
 * Presence ONLY — never contents. That file holds Slack bot and app tokens.
 */

import { SLACK_ENV_ABSOLUTE } from './slack-platform';

export interface BootCheckFacts {
  gatewayUser: string;
  /** true ⇒ the gosu drop worked. */
  nonRoot: boolean;
  /**
   * Tri-state on purpose. `undefined` means the probe said nothing about Slack
   * — i.e. the deployed Worker predates this check. A caller must not read a
   * missing field as "Slack is gone" and re-push on every tick against an
   * older deployment.
   */
  slackEnvPresent: boolean | undefined;
}

/**
 * `-s` rather than `-f`: a zero-byte file is not a usable config, and reading
 * it as missing is what makes the re-push path self-correcting. (Disable
 * already `rm -f`s the file, so the two only differ on a truncated write.)
 */
export const BOOT_CHECK_COMMAND =
  "printf 'gateway_user=%s\\n' \"$(ps -o user= -p \"$(pgrep -f 'hermes gateway' | head -1)\" 2>/dev/null | tr -d ' ')\"; "
  + `printf 'slack_env=%s\\n' "$([ -s '${SLACK_ENV_ABSOLUTE}' ] && echo present || echo missing)"`;

export function parseBootCheck(stdout: string | undefined): BootCheckFacts {
  const out = (stdout ?? '').trim();
  const gatewayUser = (out.match(/gateway_user=(\S+)/) || [])[1] ?? '';
  const slackEnv = (out.match(/slack_env=(\S+)/) || [])[1] ?? '';
  return {
    gatewayUser,
    nonRoot: gatewayUser !== '' && gatewayUser !== 'root',
    // Anything other than the two words we print is treated as "no answer"
    // rather than guessed at — a garbled probe must not trigger a re-push.
    slackEnvPresent:
      slackEnv === 'present' ? true : slackEnv === 'missing' ? false : undefined,
  };
}
