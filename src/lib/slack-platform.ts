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
    `  grep -vE '^SLACK_' ${shellSingleQuote(`${home}/.hermes/.env`)} > /tmp/hermes-env-merge || true`,
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
