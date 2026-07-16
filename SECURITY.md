# Security policy

## Reporting a vulnerability

If you discover a security issue in `hermesworkers`, please **do not file a public issue**. Instead, open a private security advisory on GitHub:

> Repository → Security → Advisories → "Report a vulnerability"

That route notifies the maintainers privately and gives us a place to coordinate a fix before any details become public.

## Scope

This repository is in scope:

- the Worker code under `src/`,
- the container image and startup script under `container/`,
- the documentation under `docs/`.

The following are **not** in scope (report upstream instead):

- Bugs in Hermes itself → <https://github.com/NousResearch/hermes-agent/issues>
- Bugs in Cloudflare Workers, Sandbox or Wrangler → Cloudflare's [bug-bounty programme](https://hackerone.com/cloudflare)
- Bugs in Anthropic / OpenRouter / OpenAI APIs → each provider's own disclosure channel

## Security model & hardening

`hermesworkers` is **single-tenant**: one Worker deployment owns exactly one
Hermes container. The Worker is the only trust boundary — the container is
unreachable from the public internet except through it.

Controls in place:

- **Fail-closed auth.** Protected routes (`/v1/*`, `/api/*`, the dashboard
  hostname) require a token. With none configured the Worker returns `503`
  rather than serving openly; open mode is an explicit `ALLOW_UNAUTHENTICATED=true`
  opt-in for local dev only.
- **Privilege separation.** `API_TOKEN` grants chat/inference; `ADMIN_TOKEN`
  (separate) grants destructive control (`restart`, `restart-gateway`, `stop`,
  `logs`). A chat-token holder cannot restart the instance or read logs.
- **Constant-time token comparison** (SHA-256 digest compare) on every check.
- **Mandatory Worker↔container secret.** `HERMES_GATEWAY_TOKEN` is required; the
  container refuses to boot an unauthenticated gateway (no `change-me` default).
- **Non-root agent.** The Hermes gateway/dashboard processes run as an
  unprivileged `hermes` user (privileges dropped via `gosu` after boot).
- **Verified supply chain in the image.** The Node.js tarball is fetched over
  verified TLS and checked against a pinned SHA-256; Hermes is cloned from a
  pinned ref with no silent unpinned fallback.
- **Secret hygiene.** `~/.hermes/.env` is `0600` under a `0700` dir; the `logs`
  endpoint prints env-var *names only* and redacts key/token/secret values from
  `hermes config show`; the dashboard proxy strips the Worker's auth credentials
  before forwarding.
- **Optional rate limiting** on chat and admin routes (`CHAT_RATE_LIMITER` /
  `ADMIN_RATE_LIMITER`).

Known residual risks (by design, single-tenant): a single leaked `ADMIN_TOKEN`
grants full instance control; unbounded provider spend is possible for any valid
chat-token holder (mitigate with rate limits + provider-side spend caps). For
multi-user access, front the Worker with Cloudflare Access.

## Response targets

- Acknowledge the report: within 5 business days.
- First triage: within 10 business days.
- Resolution / disclosure timeline: agreed jointly with the reporter.

There is no formal bug bounty for `hermesworkers`. We are happy to credit researchers in release notes when they want public attribution.
