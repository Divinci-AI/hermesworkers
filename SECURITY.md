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

## Response targets

- Acknowledge the report: within 5 business days.
- First triage: within 10 business days.
- Resolution / disclosure timeline: agreed jointly with the reporter.

There is no formal bug bounty for `hermesworkers`. We are happy to credit researchers in release notes when they want public attribution.
