/**
 * Slack Socket Mode platform apply helpers for hosted multi-tenant agents.
 *
 * public-api POSTs a JSON body (HermesSlackApplyPayload) to
 * `/hosted/agent/platforms/slack`. We persist SLACK_* env to a durable file
 * under ~/.hermes/ so start-hermes.sh re-injects it on every cold boot, then
 * restart the gateway so the Socket Mode adapter connects.
 *
 * Private org channels use G… ids in SLACK_ALLOWED_CHANNELS (and require the
 * Slack app scopes/events documented on the Divinci UI checklist).
 */

/** Path relative to the hermes home; start-hermes.sh sources this into .env. */
export const SLACK_ENV_RELATIVE_PATH = '.hermes/divinci-platforms/slack.env';
export const SLACK_ENV_ABSOLUTE = `/home/hermes/${SLACK_ENV_RELATIVE_PATH}`;

/** Matches the public-api HermesSlackApplyPayload shape. */
export interface SlackApplyBody {
  enabled: boolean;
  botToken?: string;
  appToken?: string;
  allowedUsers?: string;
  /**
   * Open the agent to EVERY member of the Slack workspace.
   *
   * Hermes' gate (`plugins/platforms/slack/adapter.py`) checks
   * SLACK_ALLOW_ALL_USERS first, then the SLACK_ALLOWED_USERS list, and
   * otherwise DENIES. So an empty allowlist is deny-all, not allow-all —
   * without this flag there is no way to express "the whole workspace".
   */
  allowAllUsers?: boolean;
  allowedChannels?: string;
  freeResponseChannels?: string;
  homeChannel?: string;
  homeChannelName?: string;
  replyInThread?: boolean;
  requireMention?: boolean;
}

export type SlackApplyParse =
  | { ok: true; body: SlackApplyBody }
  | { ok: false; status: 400; error: string };

/**
 * Parse + light-validate the JSON body. Token prefixes are enforced when
 * enabled so we fail closed before writing secrets into the container.
 */
export function parseSlackApplyBody(raw: unknown): SlackApplyParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, status: 400, error: 'body must be a JSON object' };
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') {
    return { ok: false, status: 400, error: 'enabled (boolean) is required' };
  }

  const str = (k: string): string | undefined => {
    if (o[k] === undefined || o[k] === null) return undefined;
    if (typeof o[k] !== 'string') {
      throw new Error(`${k} must be a string`);
    }
    return (o[k] as string).trim();
  };

  let body: SlackApplyBody;
  try {
    body = {
      enabled: o.enabled,
      botToken: str('botToken'),
      appToken: str('appToken'),
      allowedUsers: str('allowedUsers') ?? '',
      allowAllUsers: o.allowAllUsers === true,
      allowedChannels: str('allowedChannels') ?? '',
      freeResponseChannels: str('freeResponseChannels') ?? '',
      homeChannel: str('homeChannel'),
      homeChannelName: str('homeChannelName'),
      replyInThread: typeof o.replyInThread === 'boolean' ? o.replyInThread : true,
      requireMention: typeof o.requireMention === 'boolean' ? o.requireMention : true,
    };
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : String(e) };
  }

  if (body.enabled) {
    if (!body.botToken || !body.botToken.startsWith('xoxb-')) {
      return {
        ok: false,
        status: 400,
        error: 'enabled Slack requires botToken starting with xoxb-',
      };
    }
    if (!body.appToken || !body.appToken.startsWith('xapp-')) {
      return {
        ok: false,
        status: 400,
        error: 'enabled Slack requires appToken starting with xapp- (Socket Mode)',
      };
    }
    if (body.botToken.length > 400 || body.appToken.length > 500) {
      return { ok: false, status: 400, error: 'token value too long' };
    }
  }

  return { ok: true, body };
}

/** Escape a value for a KEY=value line (no newlines; quotes not needed if we base64 the file). */
function envLine(key: string, value: string): string {
  // Values may contain # or spaces — write as-is; file is not shell-sourced with
  // unquoted expansion, start-hermes.sh appends lines into Hermes' .env reader.
  const v = value.replace(/\r?\n/g, ' ').trim();
  return `${key}=${v}`;
}

/**
 * Build the durable slack.env file contents (or empty string when disabled).
 * When disabled we delete the file rather than writing empty tokens.
 */
export function buildSlackEnvFile(body: SlackApplyBody): string | null {
  if (!body.enabled) return null;
  const lines: string[] = [
    '# Written by Divinci public-api via /hosted/agent/platforms/slack',
    '# Merged into ~/.hermes/.env on every start-hermes.sh boot.',
    envLine('SLACK_BOT_TOKEN', body.botToken!),
    envLine('SLACK_APP_TOKEN', body.appToken!),
  ];
  // Written only when true: Hermes treats the mere PRESENCE of a truthy value
  // as open access, so emitting `SLACK_ALLOW_ALL_USERS=false` is fine but
  // omitting it entirely keeps the deny-by-default path unambiguous.
  if (body.allowAllUsers) lines.push(envLine('SLACK_ALLOW_ALL_USERS', 'true'));
  if (body.allowedUsers) lines.push(envLine('SLACK_ALLOWED_USERS', body.allowedUsers));
  if (body.allowedChannels) lines.push(envLine('SLACK_ALLOWED_CHANNELS', body.allowedChannels));
  if (body.freeResponseChannels) {
    lines.push(envLine('SLACK_FREE_RESPONSE_CHANNELS', body.freeResponseChannels));
  }
  if (body.homeChannel) lines.push(envLine('SLACK_HOME_CHANNEL', body.homeChannel));
  if (body.homeChannelName) lines.push(envLine('SLACK_HOME_CHANNEL_NAME', body.homeChannelName));
  lines.push(''); // trailing newline
  return lines.join('\n');
}

/**
 * SLACK_* keys the Divinci panel OWNS unconditionally: they are removed from
 * the live `.env` on every apply and re-added only if this apply sets them.
 *
 * The distinction matters for the ones written CONDITIONALLY. `buildSlackEnvFile`
 * emits `SLACK_ALLOW_ALL_USERS` only when it is true, so if these keys were
 * merely "replaced when present" then turning open access back OFF would leave
 * the previous `SLACK_ALLOW_ALL_USERS=true` in place — a save that reads as
 * tightening access while actually changing nothing.
 */
const PANEL_OWNED_SLACK_KEYS = [
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_ALLOW_ALL_USERS',
  'SLACK_ALLOWED_USERS',
  'SLACK_ALLOWED_CHANNELS',
  'SLACK_FREE_RESPONSE_CHANNELS',
] as const;

/**
 * Home-channel keys are SHARED ownership: the panel writes them, and so does
 * Hermes' own `/sethome` slash command — which persists via
 * `save_env_value("SLACK_HOME_CHANNEL", ...)` into the very same `.env`
 * (hermes-agent gateway/slash_commands.py::_handle_set_home_command). Env is
 * not a second-class path for this setting; it is the ONLY path. There is no
 * `hermes config set` key for a home channel.
 *
 * So they are owned only when this apply actually supplies one. An apply that
 * leaves the panel field blank must PRESERVE whatever `/sethome` wrote, the
 * same "absent means unchanged" rule the connector secrets use.
 *
 * `_THREAD_ID` follows the channel: `/sethome` writes it alongside (empty when
 * run outside a thread) and the panel cannot express a thread, so carrying a
 * stale thread id onto a newly-chosen channel would deliver cron output into a
 * thread that belongs to a different conversation.
 */
const HOME_CHANNEL_SLACK_KEYS = [
  'SLACK_HOME_CHANNEL',
  'SLACK_HOME_CHANNEL_NAME',
  'SLACK_HOME_CHANNEL_THREAD_ID',
] as const;

/**
 * The SLACK_* keys this apply should strip from the live `.env` before
 * appending the durable file.
 *
 * Everything NOT listed is preserved. Hermes supports far more SLACK_* vars
 * than the panel models (SLACK_STRICT_MENTION, SLACK_REACTIONS,
 * SLACK_ALLOW_BOTS, …); a blanket `^SLACK_` strip silently deletes every one
 * of them on a save that was only meant to change the mention setting.
 */
export function slackEnvKeysOwnedByThisApply(body: SlackApplyBody): string[] {
  const keys: string[] = [...PANEL_OWNED_SLACK_KEYS];
  if (body.homeChannel) keys.push(...HOME_CHANNEL_SLACK_KEYS);
  return keys;
}

/** An ERE matching `KEY=` at line start for each owned key. */
export function slackOwnedKeyStripPattern(body: SlackApplyBody): string {
  return `^(${slackEnvKeysOwnedByThisApply(body).join('|')})=`;
}

/**
 * Build a shell script that (as root) writes or removes the durable Slack env
 * file and applies hermes config knobs for threading / mention behavior.
 * Content is base64-encoded so token chars never break the shell.
 */
export function buildSlackApplyShell(body: SlackApplyBody): string {
  const home = '/home/hermes';
  const dir = `${home}/.hermes/divinci-platforms`;
  const file = `${dir}/slack.env`;
  const envContent = buildSlackEnvFile(body);

  if (envContent === null) {
    // Disable: remove durable file; strip SLACK_* lines from live .env if present.
    return [
      'set -euo pipefail',
      `rm -f ${shellSingleQuote(file)}`,
      // Best-effort strip of prior SLACK_ lines from the live env (next boot is authoritative).
      `if [ -f ${shellSingleQuote(`${home}/.hermes/.env`)} ]; then`,
      `  grep -vE '^SLACK_' ${shellSingleQuote(`${home}/.hermes/.env`)} > /tmp/hermes-env-noslack || true`,
      `  mv /tmp/hermes-env-noslack ${shellSingleQuote(`${home}/.hermes/.env`)}`,
      `  chmod 600 ${shellSingleQuote(`${home}/.hermes/.env`)} || true`,
      'fi',
      `chown -R hermes:hermes ${shellSingleQuote(`${home}/.hermes`)} 2>/dev/null || true`,
      'echo "slack_disabled=1"',
    ].join('\n');
  }

  const b64 = utf8ToBase64(envContent);
  const replyInThread = body.replyInThread !== false ? 'true' : 'false';
  const requireMention = body.requireMention !== false ? 'true' : 'false';

  return [
    'set -euo pipefail',
    `mkdir -p ${shellSingleQuote(dir)}`,
    `chmod 700 ${shellSingleQuote(`${home}/.hermes`)} 2>/dev/null || true`,
    `printf %s ${shellSingleQuote(b64)} | base64 -d > ${shellSingleQuote(file)}`,
    `chmod 600 ${shellSingleQuote(file)}`,
    // Also merge into the live .env immediately so a running gateway that
    // re-reads env (or a soft restart) sees tokens without waiting for start-hermes.
    `if [ -f ${shellSingleQuote(`${home}/.hermes/.env`)} ]; then`,
    // grep exits 1 when it selects no lines — a legitimate result when the
    // live .env held nothing but keys this apply owns. Swallowing every
    // non-zero with `|| true` would treat a genuine grep FAILURE the same way
    // and silently drop the whole non-Slack environment, so only >1 aborts.
    `  set +e`,
    `  grep -vE ${shellSingleQuote(slackOwnedKeyStripPattern(body))} ${shellSingleQuote(`${home}/.hermes/.env`)} > /tmp/hermes-env-merge`,
    `  rc=$?`,
    `  set -e`,
    `  if [ "$rc" -gt 1 ]; then echo "slack_env_merge_failed=1" >&2; exit 1; fi`,
    `  cat ${shellSingleQuote(file)} >> /tmp/hermes-env-merge`,
    `  mv /tmp/hermes-env-merge ${shellSingleQuote(`${home}/.hermes/.env`)}`,
    `  chmod 600 ${shellSingleQuote(`${home}/.hermes/.env`)}`,
    'else',
    `  cp ${shellSingleQuote(file)} ${shellSingleQuote(`${home}/.hermes/.env`)}`,
    `  chmod 600 ${shellSingleQuote(`${home}/.hermes/.env`)}`,
    'fi',
    // Behavioral knobs (Hermes config.yaml). Best-effort — env is the primary path.
    `hermes config set platforms.slack.extra.reply_in_thread ${replyInThread} 2>/dev/null || true`,
    `hermes config set slack.require_mention ${requireMention} 2>/dev/null || true`,
    `hermes config set platforms.slack.require_mention ${requireMention} 2>/dev/null || true`,
    // ⛔ `allow_bots: all` + `require_mention: false` is an unbounded
    // bot-to-bot loop, and our agents SHARE channels: as of 2026-08-29 three
    // Hermes bots sit in #hermes (Local, Team, Sigma) and Local already runs
    // `slack.allow_bots: all`. Today only require_mention stands between that
    // and every agent answering every other agent forever — a one-field edit
    // away, on a field whose name does not hint at the danger.
    //
    // So the pair is made unrepresentable HERE rather than documented: turning
    // mentions off also pins bot messages off. An agent that must both listen
    // to bots and answer unmentioned needs a deliberate manual config on a
    // single instance, not a provisioning default that reaches the fleet.
    ...(requireMention === 'false'
      ? [`hermes config set slack.allow_bots none 2>/dev/null || true`]
      : []),
    `chown -R hermes:hermes ${shellSingleQuote(`${home}/.hermes`)} 2>/dev/null || true`,
    'echo "slack_enabled=1"',
    `wc -c < ${shellSingleQuote(file)} | tr -d ' ' | xargs -I{} echo "slack_env_bytes={}"`,
  ].join('\n');
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** UTF-8 → base64 without Node `Buffer` (Workers + vitest both support this). */
function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}
