/**
 * Hostname-based reverse proxy for the native Hermes dashboard.
 *
 * The native dashboard ships its own React app + WebSocket on port 9119 inside
 * the container. Serving it under a dedicated hostname (rather than a path on
 * the main Worker route) lets all the dashboard's absolute URLs (`/static/*`,
 * `/v1/*`, `ws://.../ws`) resolve naturally — no HTML rewriting required.
 *
 * Wire-up:
 *   1. Set `DASHBOARD_HOSTNAME` in wrangler.toml (e.g. `hermes.example.com`).
 *   2. Add a matching Worker Route pointing to this Worker.
 *   3. Add a DNS record (proxied) for that hostname.
 *
 * See `docs/custom-domain.md` for a step-by-step.
 *
 * When no custom hostname is configured this module is a no-op — the Worker
 * keeps serving its API routes on the workers.dev URL.
 */

import { getContainer, collectProviderKeys, type Env } from '../lib/container';
import {
  ensureGateway,
  HERMES_DASHBOARD_PORT,
} from './container-lifecycle';

/**
 * Returns a Response when `request` targets the configured dashboard hostname,
 * or `null` if the request should fall through to the normal Hono router.
 */
export async function maybeHandleDashboard(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (!env.DASHBOARD_HOSTNAME) return null;
  const url = new URL(request.url);
  if (url.hostname.toLowerCase() !== env.DASHBOARD_HOSTNAME.toLowerCase()) {
    return null;
  }

  // Optional bearer-token gate. If API_TOKEN is set, require the same token on
  // the dashboard hostname so it isn't exposed to the public internet.
  if (env.API_TOKEN) {
    const cookieToken = parseTokenCookie(request.headers.get('cookie') || '');
    const authHeader = request.headers.get('authorization') || '';
    const bearer = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const provided = cookieToken || bearer;
    if (provided !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
  }

  const container = getContainer(env);
  try {
    await ensureGateway(container, {
      providerKeys: collectProviderKeys(env),
      gatewayToken: env.HERMES_GATEWAY_TOKEN,
      defaultModel: env.HERMES_DEFAULT_MODEL,
    });
  } catch (err) {
    return new Response(
      `Container not ready: ${err instanceof Error ? err.message : String(err)}`,
      { status: 503 },
    );
  }

  // Forward request 1:1 to the dashboard port inside the container.
  // The Sandbox SDK's containerFetch preserves WebSocket upgrades, which the
  // dashboard's live chat tab relies on.
  const isWebSocket =
    (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';

  const targetUrl = `http://localhost:${HERMES_DASHBOARD_PORT}${url.pathname}${url.search}`;
  const targetReq = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  });

  let response: Response;
  try {
    response = await (container as any).containerFetch(
      targetReq,
      HERMES_DASHBOARD_PORT,
    );
  } catch (err) {
    return new Response(
      `Proxy error: ${err instanceof Error ? err.message : String(err)}`,
      { status: 502 },
    );
  }

  // WebSocket responses already have the upgrade socket attached.
  if (isWebSocket) return response;

  return response;
}

function parseTokenCookie(cookieHeader: string): string {
  const match = cookieHeader.match(/hw_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}
