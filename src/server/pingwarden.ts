// Calls to the Pingwarden API. The browser never talks to Pingwarden: every request goes
// through here, with the user's access token (OIDC) or the instance's API token.
import type { InstanceConfig } from './config.ts';

export interface PwResponse {
  status: number;
  /** The response body as received (JSON for every /api/v1 endpoint). */
  text: string;
}

/** Pingwarden could not be reached, or answered with something that is not its API. */
export class PwUnavailable extends Error {
  readonly status: 502 | 504;
  constructor(status: 502 | 504, message: string) {
    super(message);
    this.status = status;
  }
}

/** A Pingwarden answer other than 2xx, with its `{"error": …}` message. */
export class PwError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function errorMessage(r: PwResponse): string {
  try {
    const b = JSON.parse(r.text) as { error?: unknown };
    if (typeof b.error === 'string') return b.error;
  } catch {
    // not JSON
  }
  return `Pingwarden answered HTTP ${r.status}`;
}

type Method = 'GET' | 'POST';

export class Pingwarden {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  /** The instance's API token (AUTH_MODE=token). */
  readonly token: string | null;
  private readonly timeoutMs: number;

  constructor(cfg: InstanceConfig, timeoutMs: number) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.baseUrl = cfg.url;
    this.token = cfg.token;
    this.timeoutMs = timeoutMs;
  }

  private init(method: Method, token: string | null, body: unknown, signal: AbortSignal): RequestInit {
    return {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
      redirect: 'error',
    };
  }

  private unavailable(e: unknown): PwUnavailable {
    const err = e as Error;
    if (err.name === 'TimeoutError') {
      return new PwUnavailable(504, `${this.name} did not answer within ${this.timeoutMs / 1000} s`);
    }
    const cause = (err.cause as Error | undefined)?.message;
    return new PwUnavailable(502, `${this.name} is unreachable: ${cause ?? err.message}`);
  }

  /** One API call; `path` starts after /api/v1. Throws PwUnavailable only, never on a status. */
  async request(
    path: string,
    { method = 'GET', token = null, body }: { method?: Method; token?: string | null; body?: unknown } = {},
  ): Promise<PwResponse> {
    let res: Response;
    try {
      res = await fetch(
        `${this.baseUrl}/api/v1${path}`,
        this.init(method, token, body, AbortSignal.timeout(this.timeoutMs)),
      );
    } catch (e) {
      throw this.unavailable(e);
    }
    return this.answer(res, path, await res.text());
  }

  /**
   * An answer to relay. Pingwarden's own errors are JSON; an older Pingwarden answers a route it
   * does not have with an empty 404 (405 for another method), which becomes a JSON "not found".
   * Anything else without JSON (a proxy's error page, a wrong URL) is not relayed.
   */
  private answer(res: Response, path: string, text: string): PwResponse {
    if ((res.headers.get('content-type') ?? '').includes('json')) return { status: res.status, text };
    if ((res.status === 404 || res.status === 405) && !text.trim()) {
      return {
        status: res.status,
        text: JSON.stringify({ error: `${this.name} has no ${path} (an older Pingwarden?)` }),
      };
    }
    throw new PwUnavailable(502, `${this.name} answered HTTP ${res.status} without JSON; check its URL`);
  }

  /** A GET whose JSON body is needed by the UI server itself. */
  async json<T>(path: string, token: string | null): Promise<T> {
    const r = await this.request(path, { token });
    if (r.status < 200 || r.status >= 300) throw new PwError(r.status, errorMessage(r));
    return JSON.parse(r.text) as T;
  }

  /**
   * Opens the live stream (/api/v1/stream). On success the response body is the event stream,
   * until `signal` aborts it; otherwise the JSON error response.
   */
  async stream(token: string | null, signal: AbortSignal): Promise<{ ok: true; body: ReadableStream } | PwResponse> {
    let res: Response;
    // The timeout covers the connection only: the stream itself lasts until `signal`.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new DOMException('connection timeout', 'TimeoutError')), this.timeoutMs);
    const onAbort = () => ctl.abort(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      res = await fetch(`${this.baseUrl}/api/v1/stream`, {
        ...this.init('GET', token, undefined, ctl.signal),
        headers: { accept: 'text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
    } catch (e) {
      signal.removeEventListener('abort', onAbort);
      throw this.unavailable(ctl.signal.reason ?? e);
    } finally {
      clearTimeout(timer);
    }
    if (res.ok && (res.headers.get('content-type') ?? '').startsWith('text/event-stream') && res.body) {
      return { ok: true, body: res.body };
    }
    return this.answer(res, '/stream', await res.text());
  }
}
