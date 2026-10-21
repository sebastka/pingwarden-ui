// Calls to the Pingwarden API. The browser never talks to Pingwarden: every request goes
// through here, with the user's access token (OIDC) or the configured API token.
import type { Config } from './config.ts';

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

export class Pingwarden {
  private readonly cfg: Config['pingwarden'];

  constructor(cfg: Config['pingwarden']) {
    this.cfg = cfg;
  }

  get baseUrl(): string {
    return this.cfg.url;
  }

  /** One API call; `path` starts after /api/v1. Throws PwUnavailable only, never on a status. */
  async request(
    path: string,
    { method = 'GET', token = null }: { method?: 'GET' | 'POST'; token?: string | null } = {},
  ): Promise<PwResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/api/v1${path}`, {
        method,
        headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: 'error',
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === 'TimeoutError') {
        throw new PwUnavailable(504, `Pingwarden did not answer within ${this.cfg.timeoutMs / 1000} s`);
      }
      const cause = (err.cause as Error | undefined)?.message;
      throw new PwUnavailable(502, `Pingwarden is unreachable: ${cause ?? err.message}`);
    }
    const text = await res.text();
    // A proxy's HTML error page or a wrong PINGWARDEN_URL: not something to relay as JSON.
    if (!(res.headers.get('content-type') ?? '').includes('json')) {
      throw new PwUnavailable(502, `Pingwarden answered HTTP ${res.status} without JSON; check PINGWARDEN_URL`);
    }
    return { status: res.status, text };
  }

  /** A GET whose JSON body is needed by the UI server itself. */
  async json<T>(path: string, token: string | null): Promise<T> {
    const r = await this.request(path, { token });
    if (r.status < 200 || r.status >= 300) throw new PwError(r.status, errorMessage(r));
    return JSON.parse(r.text) as T;
  }
}
