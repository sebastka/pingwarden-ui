// Server-side sessions, in memory. The browser holds a random cookie; the provider's tokens
// never leave this process. A restart signs everyone out (the next page load goes through the
// provider again, usually without a prompt while its own session lasts).
import { createHash, randomBytes } from 'node:crypto';

export interface Session {
  sub: string;
  name: string;
  accessToken: string;
  /** When the access token expires (ms); null when the provider did not say. */
  accessExpiresAt: number | null;
  refreshToken: string | null;
  idToken: string | null;
  /** End of the session, whatever the tokens say (SESSION_TTL_HOURS). */
  expiresAt: number;
  /** Per instance id: whether Pingwarden lets this user act, and when that was last asked. */
  access: Record<string, Access>;
}

export interface Access {
  /** null: unknown (Pingwarden without /api/v1/me, and no action tried yet). */
  canAct: boolean | null;
  checkedAt: number;
}

/** A login started at /auth/login and finished at /auth/callback. */
export interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

const LOGIN_TTL_MS = 10 * 60_000;
const MAX_PENDING_LOGINS = 10_000;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export class SessionStore {
  /** Keyed by the SHA-256 of the cookie value, so a heap dump holds no usable cookie. */
  private readonly sessions = new Map<string, Session>();
  private readonly logins = new Map<string, PendingLogin>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Stores a session and returns the cookie value for it. */
  create(s: Session): string {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha256(token), s);
    return token;
  }

  get(token: string | undefined): Session | null {
    if (!token) return null;
    const key = sha256(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(key);
      return null;
    }
    return s;
  }

  delete(token: string | undefined): Session | null {
    if (!token) return null;
    const key = sha256(token);
    const s = this.sessions.get(key) ?? null;
    this.sessions.delete(key);
    return s;
  }

  /** Removes one session object wherever it is stored (after a failed refresh). */
  drop(s: Session): void {
    for (const [k, v] of this.sessions) if (v === s) this.sessions.delete(k);
  }

  startLogin(state: string, login: Omit<PendingLogin, 'expiresAt'>): void {
    this.purge();
    // Unauthenticated callers can start logins: bound the memory they can take.
    if (this.logins.size >= MAX_PENDING_LOGINS) this.logins.delete(this.logins.keys().next().value!);
    this.logins.set(state, { ...login, expiresAt: this.now() + LOGIN_TTL_MS });
  }

  /** A pending login is used once. */
  takeLogin(state: string): PendingLogin | null {
    const l = this.logins.get(state) ?? null;
    this.logins.delete(state);
    return l && l.expiresAt > this.now() ? l : null;
  }

  purge(): void {
    const now = this.now();
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k);
    for (const [k, l] of this.logins) if (l.expiresAt <= now) this.logins.delete(k);
  }

  get size(): number {
    return this.sessions.size;
  }
}
