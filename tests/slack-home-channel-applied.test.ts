import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSlackApplyShell,
  buildSlackEnvFile,
  slackEnvKeysOwnedByThisApply,
  slackOwnedKeyStripPattern,
} from '../src/lib/slack-platform';

/**
 * KNOWN-GAPS: hermes-home-channel-env-only-never-reaches-hermes-config
 *
 * The home channel is where Hermes delivers cron results and proactive posts.
 *
 * The ORIGINAL diagnosis in that gap was WRONG and these tests replace it. It
 * read the asymmetry in `buildSlackApplyShell` — `reply_in_thread` and
 * `require_mention` pushed both as env AND via `hermes config set`, the home
 * channel pushed as env only — as the defect. It is not. Read against the
 * pinned Hermes source (NousResearch/hermes-agent v2026.7.7.2, the commit the
 * container Dockerfile installs):
 *
 *   - `gateway/config.py` applies `SLACK_HOME_CHANNEL` from the environment
 *     even when the platform came from config.yaml, and
 *   - `/sethome` itself persists via
 *     `save_env_value("SLACK_HOME_CHANNEL", chat_id)`
 *     (`gateway/slash_commands.py::_handle_set_home_command`).
 *
 * There IS no `hermes config set` key for a home channel. Env is not a
 * second-class path for this setting; it is the only path, and Divinci was
 * already writing the right thing.
 *
 * The real defect was one line away: BOTH merge sites — the apply shell here
 * and the boot merge in `container/start-hermes.sh` — did a blanket
 * `grep -vE '^SLACK_'` on the live `.env` before appending the panel's durable
 * file. So the panel deleted every SLACK_* key it does not itself model,
 * including the home channel `/sethome` had just written into that same file.
 * `/sethome` therefore appeared to work and silently did not survive the next
 * restart, while the panel reported the agent applied and Live.
 */

const here = dirname(fileURLToPath(import.meta.url));
const START_HERMES = join(here, '..', 'container', 'start-hermes.sh');

const base = {
  enabled: true,
  botToken: 'xoxb-x',
  appToken: 'xapp-x',
  allowedUsers: 'U1',
} as Parameters<typeof buildSlackApplyShell>[0];

const withHome = { ...base, homeChannel: 'C0BG3TJARA4', homeChannelName: 'hermes' };

describe('home channel delivery', () => {
  it('writes SLACK_HOME_CHANNEL into the durable env file', () => {
    const env = buildSlackEnvFile(withHome)!;
    expect(env).toContain('SLACK_HOME_CHANNEL=C0BG3TJARA4');
  });

  /**
   * The inversion of the old assertion. A `hermes config set` for the home
   * channel would write a key nothing reads — the failure mode the gap entry
   * warned about when it declined to guess one.
   */
  it('does NOT invent a `hermes config set` for the home channel', () => {
    const shell = buildSlackApplyShell(withHome);
    expect(shell).toMatch(/hermes config set .*reply_in_thread/);
    expect(shell).toMatch(/hermes config set .*require_mention/);
    expect(
      /hermes config set [^\n]*home/i.test(shell),
      'Hermes has no config key for a home channel — /sethome persists it as ' +
        'the SLACK_HOME_CHANNEL env var. A config set here writes something ' +
        'nothing reads.',
    ).toBe(false);
  });
});

describe('the apply shell preserves SLACK_* keys the panel does not own', () => {
  it('owns the conditionally-written keys unconditionally', () => {
    // SLACK_ALLOW_ALL_USERS is emitted only when true. If it were merely
    // "replaced when present", turning open access back off would leave the
    // old `=true` behind — a save that reads as tightening and changes nothing.
    expect(slackEnvKeysOwnedByThisApply(base)).toContain('SLACK_ALLOW_ALL_USERS');
    expect(buildSlackEnvFile(base)!).not.toContain('SLACK_ALLOW_ALL_USERS');
  });

  it('claims the home-channel keys only when this apply supplies one', () => {
    expect(slackEnvKeysOwnedByThisApply(withHome)).toContain('SLACK_HOME_CHANNEL');
    expect(slackEnvKeysOwnedByThisApply(base)).not.toContain('SLACK_HOME_CHANNEL');
  });

  it('clears a stale thread id when it sets a new home channel', () => {
    // /sethome writes SLACK_HOME_CHANNEL_THREAD_ID alongside the channel. The
    // panel cannot express a thread, so carrying one onto a newly-chosen
    // channel delivers cron output into another conversation's thread.
    expect(slackEnvKeysOwnedByThisApply(withHome)).toContain('SLACK_HOME_CHANNEL_THREAD_ID');
  });

  it('no longer emits a blanket ^SLACK_ strip on the enable path', () => {
    const shell = buildSlackApplyShell(withHome);
    expect(shell).not.toMatch(/grep -vE '\^SLACK_'/);
    expect(shell).toContain(slackOwnedKeyStripPattern(withHome));
  });

  it('still strips everything on DISABLE', () => {
    // Disabling Slack should leave no SLACK_* behind — preservation is for
    // saves that keep the platform on.
    const shell = buildSlackApplyShell({ ...base, enabled: false });
    expect(shell).toMatch(/grep -vE '\^SLACK_'/);
  });
});

/**
 * Runs the two merges FOR REAL against a temp filesystem. A regex assertion on
 * generated shell proves the string; only executing it proves the behaviour,
 * and this defect lived entirely in what the shell did to a file.
 */
function runApplyMerge(body: Parameters<typeof buildSlackApplyShell>[0], liveEnv: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-slack-'));
  const home = join(dir, 'home', 'hermes');
  mkdirSync(join(home, '.hermes'), { recursive: true });
  writeFileSync(join(home, '.hermes', '.env'), liveEnv);

  // The generated script is written for /home/hermes; retarget it at the temp
  // tree rather than reimplementing it, so what runs here is what ships.
  const script = buildSlackApplyShell(body)
    .split('/home/hermes')
    .join(home)
    .replace(/^chown .*$/gm, 'true');

  execFileSync('bash', ['-c', script], { encoding: 'utf8' });
  return readFileSync(join(home, '.hermes', '.env'), 'utf8');
}

function runBootMerge(durable: string | null, liveEnv: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hermes-boot-'));
  const home = join(dir, 'hermes');
  mkdirSync(join(home, '.hermes', 'divinci-platforms'), { recursive: true });
  writeFileSync(join(home, '.hermes', '.env'), liveEnv);
  if (durable !== null) {
    writeFileSync(join(home, '.hermes', 'divinci-platforms', 'slack.env'), durable);
  }

  // Extract the Slack merge block from the real start-hermes.sh so this test
  // cannot pass against a copy that has drifted from what boots.
  const full = readFileSync(START_HERMES, 'utf8');
  const start = full.indexOf('SLACK_PLATFORM_ENV="$HOME_DIR/.hermes/divinci-platforms/slack.env"');
  expect(start, 'Slack merge block not found in start-hermes.sh').toBeGreaterThan(-1);
  const end = full.indexOf('\nfi\n', start);
  const block = full.slice(start, end + 4);

  const preamble = [
    'set -eu',
    `HOME_DIR=${JSON.stringify(home)}`,
    `HERMES_ENV_FILE=${JSON.stringify(join(home, '.hermes', '.env'))}`,
    `LOG_FILE=/dev/null`,
  ].join('\n');

  execFileSync('bash', ['-c', `${preamble}\n${block}`], { encoding: 'utf8' });
  return readFileSync(join(home, '.hermes', '.env'), 'utf8');
}

describe('a /sethome home channel survives (executed, not asserted on strings)', () => {
  // What `/sethome` leaves behind, plus a key the panel has never modelled.
  const afterSethome = [
    'OTHER=keep-me',
    'SLACK_BOT_TOKEN=xoxb-old',
    'SLACK_APP_TOKEN=xapp-old',
    'SLACK_HOME_CHANNEL=C0BG3TJARA4',
    'SLACK_HOME_CHANNEL_THREAD_ID=',
    'SLACK_STRICT_MENTION=true',
    '',
  ].join('\n');

  it('apply: a save that sets no home channel keeps the one /sethome wrote', () => {
    const merged = runApplyMerge(base, afterSethome);
    expect(merged).toContain('SLACK_HOME_CHANNEL=C0BG3TJARA4');
    expect(merged).toContain('SLACK_STRICT_MENTION=true');
    expect(merged).toContain('OTHER=keep-me');
    // The tokens this apply DOES own are replaced, not duplicated.
    expect(merged).not.toContain('xoxb-old');
    expect(merged).toContain('xoxb-x');
  });

  it('apply: a save that DOES set one replaces it, and drops the stale thread id', () => {
    const merged = runApplyMerge({ ...withHome, homeChannel: 'C999NEW' }, afterSethome);
    expect(merged).toContain('SLACK_HOME_CHANNEL=C999NEW');
    expect(merged).not.toContain('C0BG3TJARA4');
    expect(merged).not.toContain('SLACK_HOME_CHANNEL_THREAD_ID');
  });

  it('boot: restarting does not delete it', () => {
    // The durable file as the panel wrote it — no home channel in it at all.
    const merged = runBootMerge(buildSlackEnvFile(base), afterSethome);
    expect(
      merged,
      'The boot merge deleted the home channel /sethome wrote — this is the ' +
        'original defect: /sethome works, then silently does not survive a restart.',
    ).toContain('SLACK_HOME_CHANNEL=C0BG3TJARA4');
    expect(merged).toContain('SLACK_STRICT_MENTION=true');
    expect(merged).toContain('SLACK_BOT_TOKEN=xoxb-x');
    expect(merged).not.toContain('xoxb-old');
  });

  it('boot: a durable file that DOES carry a home channel still wins', () => {
    const merged = runBootMerge(buildSlackEnvFile(withHome), afterSethome);
    expect(merged).toContain('SLACK_HOME_CHANNEL=C0BG3TJARA4');
    expect(merged).toContain('SLACK_HOME_CHANNEL_NAME=hermes');
    expect(merged).not.toContain('SLACK_HOME_CHANNEL_THREAD_ID');
  });

  it('boot: open access turned off does not linger', () => {
    const permissive = 'SLACK_BOT_TOKEN=xoxb-old\nSLACK_ALLOW_ALL_USERS=true\n';
    const merged = runBootMerge(buildSlackEnvFile(base), permissive);
    expect(merged).not.toContain('SLACK_ALLOW_ALL_USERS');
  });
});
