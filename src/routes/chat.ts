import { Hono } from 'hono';
import {
  getContainer,
  collectProviderKeys,
  type Env,
} from '../lib/container';
import {
  ensureGateway,
  HERMES_API_PORT,
} from '../services/container-lifecycle';

const chat = new Hono<{ Bindings: Env }>();

/**
 * OpenAI-compatible chat completions endpoint.
 *
 * Forwards the request body verbatim to the Hermes API server inside the
 * container. The Worker handles container boot, BYOK injection and (if
 * configured) bearer-token gating; everything else — including streaming —
 * is delegated to Hermes.
 */
chat.post('/v1/chat/completions', async (c) => {
  const container = getContainer(c.env);

  try {
    await ensureGateway(container, {
      providerKeys: collectProviderKeys(c.env),
      gatewayToken: c.env.HERMES_GATEWAY_TOKEN,
      defaultModel: c.env.HERMES_DEFAULT_MODEL,
    });
  } catch (err) {
    return c.json(
      {
        error: 'container_not_ready',
        message: err instanceof Error ? err.message : String(err),
      },
      503,
    );
  }

  const body = await c.req.text();
  const upstream = new Request(
    `http://localhost:${HERMES_API_PORT}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.env.HERMES_GATEWAY_TOKEN ?? ''}`,
      },
      body,
    },
  );

  let response: Response;
  try {
    response = await (container as any).containerFetch(upstream, HERMES_API_PORT);
  } catch (err) {
    return c.json(
      {
        error: 'gateway_error',
        message: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }

  // Pass the response (including the streaming body) straight back to the caller.
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
});

export { chat };
