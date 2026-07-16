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

import {
  getContainer,
  collectProviderKeys,
  requireGatewayToken,
  type Env,
} from '../lib/container';
import { checkAuth, extractBearer, extractCookieToken } from '../lib/auth';
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

  // Gate the dashboard hostname at the chat privilege level, fail-closed and in
  // constant time via the shared auth path (accepts bearer header or hw_token
  // cookie). Same fail-closed semantics as the API: no token configured ⇒ 503
  // unless ALLOW_UNAUTHENTICATED=true.
  const provided =
    extractCookieToken(request.headers.get('cookie')) ||
    extractBearer(request.headers.get('authorization'));
  const auth = await checkAuth(env, provided, 'chat');
  if (!auth.ok) {
    return new Response(auth.body?.error === 'unauthorized' ? 'Unauthorized' : 'Server misconfigured', {
      status: auth.status ?? 401,
    });
  }

  const container = getContainer(env);
  try {
    await ensureGateway(container, {
      providerKeys: collectProviderKeys(env),
      gatewayToken: requireGatewayToken(env),
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

  // Strip the Worker's own auth credentials before forwarding so the hw_token
  // cookie / bearer never reaches (or is logged by) the Hermes dashboard
  // process. The container is authenticated separately via the gateway token.
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete('authorization');
  const cookie = forwardedHeaders.get('cookie');
  if (cookie) {
    const stripped = cookie
      .split(/;\s*/)
      .filter((part) => !/^hw_token=/.test(part))
      .join('; ');
    if (stripped) forwardedHeaders.set('cookie', stripped);
    else forwardedHeaders.delete('cookie');
  }

  const targetUrl = `http://localhost:${HERMES_DASHBOARD_PORT}${url.pathname}${url.search}`;
  const targetReq = new Request(targetUrl, {
    method: request.method,
    headers: forwardedHeaders,
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
