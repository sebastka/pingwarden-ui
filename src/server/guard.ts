// Two guards against other web sites using the visitor's browser:
//   - Host allow-list: with DNS rebinding, evil.example resolves to the dashboard's address and
//     the browser treats the dashboard as same-origin with evil.example. That matters most with
//     AUTH_MODE=token, where no login stands in the way. Such requests carry
//     "Host: evil.example" and are refused.
//   - Same-origin check on state-changing requests (CSRF), from Fetch Metadata or Origin, plus a
//     custom header that a plain HTML form on another site cannot send.
import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from './config.ts';

/** "host:port", "[::1]:port" or "host" → lowercased host name without port. */
export function hostName(header: string): string {
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const i = h.lastIndexOf(':');
  return i < 0 ? h : h.slice(0, i);
}

export function allowedHosts(cfg: Config['http']): Set<string> | null {
  if (cfg.allowedHosts.includes('*')) return null;
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]', ...cfg.allowedHosts]);
  if (cfg.publicUrl) hosts.add(new URL(cfg.publicUrl).hostname.toLowerCase());
  const listen = cfg.host.toLowerCase();
  if (listen !== '0.0.0.0' && listen !== '::') hosts.add(listen.includes(':') ? `[${listen}]` : listen);
  return hosts;
}

/** The Host the request was sent to; @hono/node-server builds the URL from it (or :authority). */
const requestHost = (c: Context) => c.req.header('host') ?? new URL(c.req.url).host;

export function hostGuard(cfg: Config['http']): MiddlewareHandler {
  const hosts = allowedHosts(cfg);
  return async (c, next) => {
    // Container and Kubernetes probes address the pod IP: the health check stays reachable.
    if (!hosts || c.req.path === '/api/health') return next();
    const host = requestHost(c);
    if (!hosts.has(hostName(host))) {
      return c.text(`Host "${host}" is not allowed; set PUBLIC_URL or add it to ALLOWED_HOSTS.`, 403);
    }
    return next();
  };
}

export const CSRF_HEADER = 'x-pingwarden-ui';

export function sameOriginGuard(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') return c.json({ error: 'cross-site request refused' }, 403);
    const origin = c.req.header('origin');
    if (origin && !site) {
      let ok = false;
      try {
        ok = new URL(origin).host === requestHost(c);
      } catch {
        // malformed Origin
      }
      if (!ok) return c.json({ error: 'cross-origin request refused' }, 403);
    }
    // The logout form is a plain same-origin form; every other write is sent by the UI with
    // this header.
    if (c.req.path !== '/auth/logout' && c.req.header(CSRF_HEADER) !== '1') {
      return c.json({ error: `missing ${CSRF_HEADER} header` }, 403);
    }
    return next();
  };
}
