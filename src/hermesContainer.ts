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
  sleepAfter = '4h';

  constructor(ctx: DurableObjectState, env: unknown) {
    // The Sandbox base constructor is typed for a concrete state shape; this DO
    // holds no typed state (all state lives in the container), so cast through.
    super(ctx as DurableObjectState<Record<string, unknown>>, env as any);
    // No baseline env required here — keys are injected at process start.
  }
}
