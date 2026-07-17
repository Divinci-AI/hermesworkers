# Hosted staging deploy + isolation proof (runbook)

Goal: deploy the hosted (multi-tenant) Worker to a Divinci staging Cloudflare
account and prove two agents stay isolated with `scripts/isolation-smoke.sh`.

> **✅ ISOLATION PROVEN LIVE (2026-07-17).** `deploy-staging-stub.sh all` deployed
> the stub to a real account (Cloudflare Containers enabled; DO + container
> application created), ran the smoke test, and passed: two agents each wrote and
> read back ONLY their own marker (`isolated:true`, no cross-read), auth rejected
> a bad service token (401) and a malformed agent id (400), then torn down.
>
> **✅ REAL CHAT ANSWERS PROVEN IN THE CLOUD (2026-07-17):** a hosted agent
> returned a genuine Gemini answer (`PONG`) end-to-end via the proxy. Two
> operational rules learned the hard way:
>
> 1. **Only ship provider keys that are VALID.** Hermes makes *auxiliary* LLM
>    calls (memory/title/routing) and **fails the whole turn with "HTTP 401:
>    Missing Authentication header" if ANY configured provider key is dead** —
>    even when the main model is a different, working provider. A stale
>    `OPENAI_API_KEY` in `~/.hermes/.env` broke every Gemini turn until removed.
>    Never set a provider secret you haven't validated.
> 2. **Use a CURRENT catalog model.** A stale model id (e.g. `gemini-2.0-flash`)
>    makes Hermes silently fall back to its Nous-Portal OAuth default (which
>    can't authenticate headlessly) → the same 401. Use a model Hermes lists
>    (e.g. `google/gemini-3-flash-preview`). The Nous `nous` provider itself is
>    OAuth-device-code (interactive) and unusable in a container.
> 3. Fast diagnosis: run the built image locally (`docker run … --entrypoint bash`
>    then `hermes -z "…"`) — a ~30s loop vs a 10-min cloud deploy.
>
> **✅ FUNCTIONAL PROVEN LIVE (2026-07-17)** against **real Hermes v2026.7.7.2**
> (`IMAGE_DOCKERFILE=./container/Dockerfile SMOKE_SCRIPT=./scripts/functional-smoke.sh
> PROVIDER_KEY_OPENAI=… HERMES_MODEL=gpt-4o-mini`): both agents (a) boot the Hermes
> gateway as the NON-ROOT `hermes` user (`gatewayUser:hermes, nonRoot:true` — the
> gosu privilege drop works under Sandbox orchestration) and (b) answer chat
> completions (HTTP 200). Worker + container application torn down clean.
>
> **Gotchas hit (all fixed in the script):** (1) the staging file token is
> expired → script falls back to `wrangler login` OAuth; (2) macOS Docker
> `osxkeychain` throws `-25299` on registry cred store — clear it with
> `security delete-internet-password -s registry.cloudflare.com` (a bare
> `docker logout` is NOT enough); (3) do NOT override `DOCKER_CONFIG` to a fresh
> dir — it loses buildx and the build fails with `unknown flag: --load`.

## Prerequisites / blockers to clear first

1. **A real Hermes ref.** The Dockerfile pins `HERMES_VERSION=v2026.4.30`, a
   placeholder that will NOT clone (and now fails hard — no silent fallback). To
   deploy you must either:
   - set `HERMES_VERSION` (+ optional `HERMES_COMMIT`) to an existing
     NousResearch/hermes-agent tag/commit, **or**
   - for the isolation proof *only*, the probe endpoints (`/hosted/agent/probe`)
     need just the Sandbox container, **not** Hermes — so you can temporarily
     build a minimal image (base `cloudflare/sandbox:0.7.20` + the startup
     script stubbed to a no-op) to prove isolation without a working Hermes.
2. **Cloudflare account with Containers enabled** (Sandbox is GA-gated) and
   `wrangler` authenticated to it. From CLAUDE.md, unset `CLOUDFLARE_API_TOKEN`
   if it's exported so the OAuth session wins: `env -u CLOUDFLARE_API_TOKEN wrangler …`.
3. **Docker running** (the Sandbox image builds locally during `wrangler deploy`).

## Config

In `wrangler.toml` set `name`, `account_id`, and raise the per-agent ceiling:

```toml
[[containers]]
class_name = "HermesInstance"
image = "./container/Dockerfile"
max_instances = 10        # concurrent agent containers for the test (was 1)
instance_type = "standard-1"
```

## Secrets (hosted mode)

```bash
cd <repo>
env -u CLOUDFLARE_API_TOKEN npx wrangler secret put HERMES_GATEWAY_TOKEN   # openssl rand -hex 32
env -u CLOUDFLARE_API_TOKEN npx wrangler secret put SERVICE_AUTH_SECRET    # openssl rand -hex 32  (public-api ↔ Worker)
env -u CLOUDFLARE_API_TOKEN npx wrangler secret put ANTHROPIC_API_KEY      # only needed for real chat, not the probe
```

Setting `SERVICE_AUTH_SECRET` is what turns on the `/hosted/*` routes.

## Deploy

```bash
npm ci
npm run typecheck && npm test          # gate: 45 tests
env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
```

Note the printed `*.workers.dev` URL.

## Prove isolation

```bash
WORKER_URL=https://<worker>.<account>.workers.dev \
SERVICE_AUTH_SECRET=<the secret you set> \
./scripts/isolation-smoke.sh
```

Expected tail: `✅ ISOLATION PROVEN`. The script also asserts a wrong service
token → 401 and an invalid agentId (`../evil`) → 400.

## What this proves (and doesn't)

- **Proves:** two distinct `X-Divinci-Agent-Id` values resolve to two separate
  Sandbox containers (separate `/tmp` state, no cross-read); service auth rejects
  a bad token and a malformed id. This is the core tenant-isolation invariant.
- **Does NOT prove:** the v0.2 container hardening (non-root `gosu` boot,
  `kill -9 1` restart) — that needs the *real* Hermes image. Run the same probe
  after a Hermes-backed build, plus a `/hosted/agent/v1/chat/completions` call to
  each of two agents, to confirm both the hardening and per-agent chat.

## CI note

`scripts/isolation-smoke.sh` is a live/integration check — it needs a deployed
URL, so it is intentionally not wired into the unit-test CI. The deterministic
routing-isolation guarantees run in CI via `tests/tenant.test.ts`.
