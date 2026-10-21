import { serve } from '@hono/node-server';
import type { Server } from 'node:http';
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import { Pingwarden } from './pingwarden.ts';

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(e.message);
  process.exit(1);
}

const instances = cfg.instances.map((i) => new Pingwarden(i, cfg.pingwardenTimeoutMs));
const app = createApp(cfg, instances);
const server = serve({ fetch: app.fetch, hostname: cfg.http.host, port: cfg.http.port }, (info) => {
  const where = info.family === 'IPv6' ? `[${info.address}]` : info.address;
  const auth = cfg.auth.mode === 'oidc' ? `sign-in via ${cfg.auth.oidc!.issuer}` : 'no sign-in';
  const pws = instances.map(
    (p) =>
      `${p.name} (${p.id}: ${p.baseUrl}${cfg.auth.mode === 'token' ? (p.token ? ', API token' : ', anonymous') : ''})`,
  );
  console.log(
    `Pingwarden UI listening on http://${where}:${info.port} (${auth}${cfg.readOnly ? ', read-only' : ''}` +
      `${cfg.http.publicUrl ? `, public URL ${cfg.http.publicUrl}` : ''}); Pingwarden: ${pws.join(', ')}`,
  );
}) as Server;

// Tell at startup whether Pingwarden is reachable and accepts the token, instead of at the
// first page load. Not fatal: Pingwarden may simply start later.
if (cfg.auth.mode === 'token') {
  for (const pw of instances) {
    pw.request('/status', { token: pw.token }).then(
      (r) => {
        if (r.status === 401 || r.status === 403) {
          console.warn(
            `${pw.name} refused the dashboard's ${pw.token ? 'API token' : 'anonymous access'} (HTTP ${r.status}); ` +
              'give it a token with read scope, or enable anonymous_read.',
          );
        } else if (r.status >= 300) console.warn(`${pw.name} answered HTTP ${r.status} to /api/v1/status`);
      },
      (e: Error) => console.warn(e.message),
    );
  }
}

// Graceful shutdown on SIGTERM (docker stop) and SIGINT (Ctrl+C). Node runs as PID 1 in the
// container, where signals without a handler are ignored.
const SHUTDOWN_TIMEOUT_MS = 8000; // below Docker's default 10 s grace period
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    console.warn(`${signal} received again, exiting immediately`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  setTimeout(() => {
    console.error(`shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000} s, exiting`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    console.log('shutdown complete');
    process.exit(0);
  });
  // Idle keep-alive connections would hold close() open, and live streams never end on their
  // own: give requests in flight 2 s, then cut the rest (browsers reconnect their streams).
  server.closeIdleConnections();
  setTimeout(() => server.closeAllConnections(), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
