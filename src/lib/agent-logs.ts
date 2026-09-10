/**
 * Container log reading for the hosted surface.
 *
 * WHY THIS EXISTS: nothing could read a hosted container's log. `start-hermes.sh`
 * writes to /tmp/hermes-server.log, and Hermes' own `logs` route lives on the
 * `instance` API behind ADMIN_TOKEN/API_TOKEN — neither secret is set on these
 * Workers. Every diagnosis was black-box inference from HTTP status codes.
 *
 * This reads the file with the same raw `container.exec` that `/hosted/agent/probe`
 * and `/hosted/agent/boot-check` already use, so it needs no new secret and works
 * even when the gateway is down — which is exactly when you need it.
 *
 * ON THE FIXED SOURCE LIST: the caller names a source key, never a path. A
 * path parameter here would be an arbitrary-file-read primitive running as root
 * inside the container, which is a much larger thing than a log viewer. Adding a
 * log means adding an entry below.
 */

/** Log files a caller may name, by key. Never accept a caller-supplied path. */
export const LOG_SOURCES = {
  /** `hermes gateway` stdout+stderr, plus every `[startup]` line. The default. */
  gateway: '/tmp/hermes-server.log',
  /** `hermes dashboard` stdout+stderr. */
  dashboard: '/tmp/hermes-dashboard.log',
} as const;

export type LogSource = keyof typeof LOG_SOURCES;

export const DEFAULT_LINES = 200;
export const MAX_LINES = 2000;
/** Hard ceiling on the response body regardless of line count. */
export const MAX_LOG_CHARS = 256_000;

export function isLogSource(value: unknown): value is LogSource {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(LOG_SOURCES, value);
}

/**
 * Clamp a caller-supplied line count. Anything unparseable falls back to the
 * default rather than erroring — a log viewer that 400s on a typo is a log
 * viewer people stop reaching for.
 */
export function clampLines(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_LINES;
  return Math.min(Math.max(Math.trunc(n), 1), MAX_LINES);
}

/**
 * Secret-shaped substrings, redacted before the log leaves the container.
 *
 * The startup script logs metadata rather than values, but `hermes gateway`
 * stdout is appended verbatim and an upstream error can echo a key. The service
 * gate already restricts callers to Divinci's public-api; this is the second
 * layer, so that a log ending up in a ticket or an agent transcript is not a
 * credential disclosure. Patterns are deliberately broad — over-redacting a log
 * line costs a re-read, under-redacting costs a rotation.
 */
const REDACTIONS: Array<{ re: RegExp; label: string }> = [
  // Cloudflare API tokens (the `cfat_`-prefixed form and bare 40-char tokens
  // following an obvious key assignment).
  { re: /\bcfat_[A-Za-z0-9_-]{20,}/g, label: 'CF_TOKEN' },
  // Google/Gemini API keys.
  { re: /\bAIza[A-Za-z0-9_-]{20,}/g, label: 'GOOGLE_API_KEY' },
  // Slack bot/app/user tokens.
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, label: 'SLACK_TOKEN' },
  { re: /\bxapp-[A-Za-z0-9-]{10,}/g, label: 'SLACK_APP_TOKEN' },
  // OpenAI-style and generic vendor keys.
  { re: /\bsk-[A-Za-z0-9_-]{20,}/g, label: 'VENDOR_KEY' },
  // PEM private key blocks (Vertex SA JSON embeds one).
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, label: 'PRIVATE_KEY' },
  // JWTs (Infisical service tokens, GCP access tokens).
  { re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, label: 'JWT' },
  // Anything that reads as `SOMETHING_KEY=<value>` / `token: <value>`. Catches
  // the shapes above when they appear in a form the specific patterns miss.
  {
    re: /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)(["']?)([^\s"',}]{8,})\3/gi,
    label: 'REDACTED',
  },
];

/**
 * Redact secret-shaped values from log text.
 *
 * Returns the redacted text and how many substitutions were made, so a caller
 * can tell "clean log" from "log with things scrubbed out of it" without having
 * to diff anything.
 */
/**
 * An all-caps identifier is an env var NAME, not its value — `key_env` and
 * similar settings hold a reference to a credential rather than the credential.
 * Redacting those hides the single most useful thing in a config line ("which
 * variable does this provider read?") and protects nothing.
 *
 * Deliberately narrow: uppercase, underscore-bearing, and short. A real secret
 * that is pure `[A-Z0-9_]` and under 48 chars is not a shape any vendor issues —
 * base64/hex keys carry lowercase, and tokens are longer.
 */
function isEnvVarName(value: string): boolean {
  return value.length <= 48 && value.includes('_') && /^[A-Z][A-Z0-9_]*$/.test(value);
}

export function redactLog(text: string): { text: string; redactions: number } {
  let out = text;
  let count = 0;
  for (const { re, label } of REDACTIONS) {
    out = out.replace(re, (...args: unknown[]) => {
      // Only the generic assignment rule can match a bare reference; the vendor
      // patterns above are all specific enough that this cannot apply to them.
      if (label === 'REDACTED' && typeof args[4] === 'string' && isEnvVarName(args[4])) {
        return String(args[0]);
      }
      count += 1;
      // The assignment pattern has capture groups; keep the name and separator
      // so the line stays diagnostic ("CLOUDFLARE_API_KEY=[REDACTED]" tells you
      // the variable was set, which is usually the question being asked).
      if (label === 'REDACTED' && typeof args[1] === 'string' && typeof args[2] === 'string') {
        return `${args[1]}${args[2]}[REDACTED]`;
      }
      return `[${label} REDACTED]`;
    });
  }
  return { text: out, redactions: count };
}

/**
 * Build the shell that reads a log's tail.
 *
 * Never interpolates caller input: `source` is resolved through LOG_SOURCES and
 * `lines` is clamped to an integer, so both are trusted by construction. A
 * missing file reports itself rather than failing the request — a container that
 * has not booted far enough to create the log is a normal, informative state.
 */
export function buildLogShell(source: LogSource, lines: number): string {
  const path = LOG_SOURCES[source];
  const n = Math.trunc(lines);
  return `if [ -f ${path} ]; then tail -n ${n} ${path}; else printf '(%s does not exist)\\n' ${path}; fi`;
}
