# Hardening changelog

This document records the security hardening applied on top of `hermesworkers`
v0.1, mapping each audit finding to its fix. Every code change is verified by
`npm run typecheck` (clean) and `npm test` (23 passing auth/security tests).

## Findings → fixes

| # | Sev | Finding (v0.1) | Fix |
|---|-----|----------------|-----|
| 1 | Med | Container ran as **root** — no `USER`; the tool-executing agent had root. | Added a non-root `hermes` user (uid/gid 10001). `start-hermes.sh` drops privileges via `gosu` for the gateway + dashboard after writing config. (`container/Dockerfile`, `container/start-hermes.sh`) |
| 2 | Med | `curl -fsSLk` disabled **TLS verification** on the Node.js download; no checksum. | Removed `-k`; fetch over verified TLS and check the tarball against a **pinned SHA-256** per arch (`sha256sum -c`). (`container/Dockerfile`) |
| 3 | Low-Med | "Pinned" Hermes clone **silently fell back** to the unpinned default branch; `[web,pty]` fell back to unpinned PyPI. | Removed both fallbacks — the build **fails hard** on a bad ref. Added an optional `HERMES_COMMIT` build-arg to pin an immutable commit SHA. (`container/Dockerfile`) |
| 4 | Low | One shared token gated chat **and** destructive admin ops; open Worker if unset. | **Two privilege levels** (`chat` / `admin`) with a separate `ADMIN_TOKEN`; a chat token cannot restart/stop/read logs. Auth now **fails closed** (503) with an explicit `ALLOW_UNAUTHENTICATED` dev opt-in. (`src/lib/auth.ts`, `src/index.ts`, `src/routes/instance.ts`) |
| 5 | Low | Token compared with `!==` (**not constant-time**). | `timingSafeEqual` — SHA-256 digest compare, fixed-length loop, no length leak. Used on every check (API + dashboard). (`src/lib/auth.ts`, `src/services/dashboard-proxy.ts`) |
| 6 | Info | `custom-domain.md` documented a **gateway-token auto-injection** the code never did. | Corrected the doc to describe actual behavior; did not fake the feature. (`docs/custom-domain.md`) |
| 7 | Info | Internal gateway token defaulted to `change-me-local-dev`; Worker sent an **empty bearer** when unset. | `HERMES_GATEWAY_TOKEN` is now **mandatory**: the container refuses to boot without it, and the Worker maps a missing token to a clear 503 (`requireGatewayToken`). No weak default. (`container/start-hermes.sh`, `src/lib/container.ts`, `src/routes/*`) |
| 8 | Info | `~/.hermes` dir permissions relied on umask; world-readable `/home`. | `~/.hermes` created `0700`, `.env` `0600` under `umask 077`; ownership handed to `hermes`. Snapshot-readable `a+rX` scoped to the **non-secret** install tree only. (`container/start-hermes.sh`, `container/Dockerfile`) |
| 9 | Info | `logs` endpoint redaction only masked values **≥6 chars**; `hermes config show` could print the gateway key. | `logs` now prints env **key names only** (never values) and redacts `KEY/TOKEN/SECRET/PASSWORD` values from `config show`. Endpoint is admin-gated. (`src/routes/instance.ts`) |
| 11 | Info | CI Actions pinned to **moving tags**; no test/audit. | All Actions pinned to **commit SHAs**; added `npm test` and a production-tree `npm audit --omit=dev --audit-level=high` gate; `permissions: contents: read`. (`.github/workflows/ci.yml`) |
| 12 | — | **No lockfile** committed. | `package-lock.json` committed; CI uses `npm ci`. |
| — | — | **Zero tests.** | Added `tests/auth.test.ts` (23 tests): constant-time compare, token parsing, fail-closed behavior, and the chat-vs-admin **privilege-separation** guarantees. |

## Additional hardening (beyond the audit)

- **Rate limiting** (optional, defense-in-depth): `CHAT_RATE_LIMITER` (60/min) and
  `ADMIN_RATE_LIMITER` (10/min) native bindings, keyed by client IP. No-op when
  the bindings are absent, so local dev is unaffected. (`src/lib/auth.ts`, `wrangler.toml`)
- **Credential stripping at the proxy**: the Worker removes its own `Authorization`
  header and `hw_token` cookie before forwarding to the container, so the Hermes
  process never sees (or logs) the edge auth token. (`src/services/dashboard-proxy.ts`)
- **Latent type error fixed**: `hermesContainer.ts` DO constructor now type-checks
  against current `@cloudflare/workers-types` (v0.1 would fail the new typecheck gate).

## Items intentionally NOT changed (and why)

- **`GATEWAY_ALLOW_ALL_USERS=true`** stays — it is required for the Worker proxy to
  reach Hermes and is safe given the container is only reachable through the Worker.
- **`hermes dashboard --insecure`** stays — it only lets Hermes bind `0.0.0.0`
  (unreachable except via the Worker), not disable transport security.

## Validated

**Container builds against real Hermes (2026-07-17).** `docker build` of this
Dockerfile with `HERMES_VERSION=v2026.7.7.2` succeeds end-to-end: the Node
tarball SHA-256 check passes (pinned hashes correct), real Hermes installs, and
the `hermes dashboard --help` verification step passes. Runtime checks on the
built image confirm the hardening landed:
`id hermes` → `uid=10001(hermes)`, `gosu` at `/usr/sbin/gosu`,
`gosu hermes id -un` → `hermes`, `hermes --version` → `Hermes Agent v0.18.2
(2026.7.7.2)`. So the non-root user + privilege-drop mechanism work with real
Hermes.

## Still needs validation on the live Sandbox runtime

The gosu drop is proven at the container level; what remains is the Sandbox
*orchestration* path. On a real hosted deploy confirm that: (a) when the Sandbox
control plane launches `start-hermes.sh` via `startProcess`, the gateway/dashboard
end up running as `hermes` and can read `~/.hermes` (the script chowns before the
gosu exec), and (b) `POST /api/instance/restart` (which execs `kill -9 1`) still
succeeds — that exec runs via the control plane, not the de-rooted process, so it
should, but confirm before relying on it. `scripts/functional-smoke.sh`'s
`boot-check` asserts (a) automatically.
