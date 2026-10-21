import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
}

/** A stand-in Pingwarden: `reply` answers each request; every request is recorded. */
export async function fakePingwarden(
  reply: (req: IncomingMessage, url: URL) => { status?: number; body?: unknown; type?: string },
): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://pw');
    seen.push({ method: req.method!, path: url.pathname + url.search, authorization: req.headers.authorization });
    const r = reply(req, url);
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/json' });
    res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** A monitor as Pingwarden lists it. */
export const monitor = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: 'http',
  target: `https://${id}.example`,
  tags: [],
  enabled: true,
  interval_seconds: 60,
  depends_on: [],
  notify: [],
  status: 'up',
  ...over,
});

/** A response body as JSON, untyped (tests check its shape themselves). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (r: Response): Promise<any> => r.json();
