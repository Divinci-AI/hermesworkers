import { Hono } from 'hono';
import type { Env } from './lib/container';
import { authMiddleware, rateLimitMiddleware } from './lib/auth';
import { chat } from './routes/chat';
import { instance } from './routes/instance';
import { hosted } from './routes/hosted';
import { maybeHandleDashboard } from './services/dashboard-proxy';

export { HermesInstance } from './hermesContainer';

const app = new Hono<{ Bindings: Env }>();

// Baseline gate: every /api/* and /v1/* request needs at least the chat token.
// Fails closed (503) when no token is configured, unless ALLOW_UNAUTHENTICATED
// is explicitly set. Destructive control routes add an admin-level gate on top
// (see routes/instance.ts). Rate limiting runs first so unauthenticated floods
// are shed before any token comparison.
app.use('/v1/*', rateLimitMiddleware('chat'), authMiddleware('chat'));
app.use('/api/*', rateLimitMiddleware('chat'), authMiddleware('chat'));

app.route('/', chat);
app.route('/', instance);

// Hosted multi-tenant routes carry their own service-auth gate (see routes/hosted.ts),
// so they are mounted outside the chat/admin middleware above.
app.route('/', hosted);

app.get('/', (c) =>
  c.json({
    name: 'hermesworkers',
    description: 'Hermes Agent on Cloudflare Sandbox',
    endpoints: {
      health: 'GET /api/health',
      chat: 'POST /v1/chat/completions',
      wake: 'POST /api/instance/wake',
      restart: 'POST /api/instance/restart',
      restartGateway: 'POST /api/instance/restart-gateway',
      stop: 'POST /api/instance/stop',
      logs: 'GET /api/instance/logs',
    },
    docs: 'https://github.com/PlaydaDev/hermesworkers',
  }),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Hostname-based dashboard proxy takes precedence over the Hono router so
    // every path under DASHBOARD_HOSTNAME hits the native Hermes web UI.
    const dashboardResponse = await maybeHandleDashboard(request, env);
    if (dashboardResponse) return dashboardResponse;

    return app.fetch(request, env, ctx);
  },
};
