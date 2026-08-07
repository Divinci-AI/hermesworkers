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
  // proven (2026-08-07). Socket-mode always-on agents keep the container warm
  // via keepalive traffic; HTTP agents only wake per turn, so a long idle
  // window is pure waste. Override with HERMES_SLEEP_AFTER (e.g. "10m") on
  // the Worker if a workload needs longer.
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
