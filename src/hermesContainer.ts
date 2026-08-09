import { Sandbox } from '@cloudflare/sandbox';

/**
 * Durable Object that owns the Hermes Sandbox container.
 *
 * In hermesworkers there is exactly one container per Worker deployment
 * (single-tenant mode). The Worker resolves this DO by a fixed instance
 * name (see `getContainer()` in `lib/container.ts`) and all chat / dashboard
 * traffic flows through the same stub.
 *
 * The Hermes process itself is launched on-demand from `container-lifecycle.ts`
 * by calling `startProcess('/usr/local/bin/start-hermes.sh', ...)`.
 *
 * Provider API keys (Anthropic / OpenRouter / OpenAI) are injected through
 * env vars at process start, not baked into the image — see `ensureGateway()`.
 */
export class HermesInstance extends Sandbox {
  defaultPort = 18789;
  // Idle containers auto-sleep after this window — the primary compute-cost
  // bound for hosted agents (a container that stops receiving requests costs
  // nothing while asleep and wakes lazily on the next turn).
  //
  // History: 4h → 30m (GA cost control) → 5m once Slack HTTP Events mode is
  // proven (2026-08-07). HTTP agents only wake per turn, so a long idle window
  // is pure waste. Override with HERMES_SLEEP_AFTER on the Worker.
  //
  // ⚠️ 5m is only safe when NO socket-mode agent runs on this Worker. The claim
  // that "socket-mode agents keep the container warm via keepalive traffic" —
  // which this comment used to make — is false whenever the keepalive interval
  // exceeds this window. Divinci probes every 10 minutes, so at 5m the
  // container is always asleep when probed: each tick REPLACES it, the Slack
  // config is lost, the sweep re-pushes it, and the gateway restart announces
  // itself in the customer's Slack channel. `wrangler.production.toml` sets 30m
  // for that reason. (An earlier note here claimed this was observed on an
  // exact 10-minute Slack cadence; it was not — Slack's record shows three such
  // messages in five days. The arithmetic is the evidence, not that.)
  //
  // The invariant to preserve is a relationship, not a number: this window must
  // be LONGER than the keepalive interval of whatever polls the container.
  sleepAfter = '5m';

  constructor(ctx: DurableObjectState, env: unknown) {
    // The Sandbox base constructor is typed for a concrete state shape; this DO
    // holds no typed state (all state lives in the container), so cast through.
    super(ctx as DurableObjectState<Record<string, unknown>>, env as any);
    const override = (env as { HERMES_SLEEP_AFTER?: string } | null)?.HERMES_SLEEP_AFTER?.trim();
    if (override) {
      this.sleepAfter = override;
    }
    // No baseline env required here — keys are injected at process start.
  }
}
