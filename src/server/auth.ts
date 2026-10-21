// OpenID Connect login (authorization code flow with PKCE) for AUTH_MODE=oidc. The UI is a
// confidential (or public) client of the provider; Pingwarden validates the resulting access
// tokens itself, so Pingwarden, not this server, decides who may read and who may act.
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oidc from 'openid-client';
import type { Config, OidcConfig, TokenAuthMethod } from './config.ts';
import { errorMessage, type Pingwarden, PwUnavailable } from './pingwarden.ts';
import { type Session, SessionStore } from './sessions.ts';

/** `pw`: the instance an /api/i/:inst/… request is for. */
export type AppEnv = { Variables: { session: Session | null; pw: Pingwarden } };

const SESSION_COOKIE = 'pingwarden_ui_session';
const LOGIN_COOKIE = 'pingwarden_ui_login';
/** The only routes reachable without a session. */
const PUBLIC_PATHS = new Set(['/auth/login', '/auth/callback', '/auth/logout', '/auth/logged-out', '/api/health']);
/** An access token this close to its expiry is refreshed before use. */
const REFRESH_MARGIN_MS = 30_000;

/** The session ended (expired, refresh refused): the user has to sign in again. */
export class SessionExpired extends Error {
  constructor(message = 'your session has expired; sign in again') {
    super(message);
  }
}

/** Only same-site relative paths are accepted as post-login redirect targets. */
export function safeReturnTo(v: string | undefined | null): string {
  if (!v || !v.startsWith('/') || v.startsWith('//') || v.startsWith('/\\') || v.startsWith('/auth/')) return '/';
  return v;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The payload of a JWT, unverified; null for opaque tokens. */
export function jwtClaims(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return isPlainObject(claims) ? claims : null;
  } catch {
    return null;
  }
}

/** Maps OIDC_TOKEN_AUTH_METHOD to openid-client's client authentication (validated at startup). */
export function clientAuth(method: TokenAuthMethod, secret: string | null): oidc.ClientAuth {
  switch (method) {
    case 'client_secret_basic':
      return oidc.ClientSecretBasic(secret!);
    case 'client_secret_post':
      return oidc.ClientSecretPost(secret!);
    case 'client_secret_jwt':
      return oidc.ClientSecretJwt(secret!);
    case 'none':
      return oidc.None();
  }
}

/** A minimal page with no script at all, so its own CSP can allow its inline style. */
export const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";

function page(c: Context, status: 200 | 401 | 403 | 502, title: string, message: string, link = 'Try again') {
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  c.header('content-security-policy', PAGE_CSP);
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#0b0b0b;background:#f9f9f7}
h1{font-size:20px}@media (prefers-color-scheme:dark){body{color:#fff;background:#0d0d0d}a{color:#86b6ef}}</style>
<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/auth/login">${esc(link)}</a></p>`,
    status,
  );
}

const displayName = (claims: Record<string, unknown>): string => {
  for (const k of ['preferred_username', 'name', 'email']) if (typeof claims[k] === 'string') return claims[k];
  return String(claims.sub);
};

export class Auth {
  readonly store: SessionStore;
  private readonly cfg: OidcConfig;
  private readonly publicUrl: string;
  private readonly instances: Pingwarden[];
  private discovery: Promise<oidc.Configuration> | null = null;
  private readonly refreshing = new Map<Session, Promise<string>>();

  constructor(cfg: Config, instances: Pingwarden[], store = new SessionStore()) {
    this.cfg = cfg.auth.oidc!;
    this.publicUrl = cfg.http.publicUrl!;
    this.instances = instances;
    this.store = store;
    // Sessions of users who never come back would otherwise stay until the next sign-in.
    setInterval(() => store.purge(), 10 * 60_000).unref();
  }

  private get secureCookies(): boolean {
    return this.publicUrl.startsWith('https://');
  }

  /** Lazily discovers the provider; a failed discovery is retried on the next request. */
  private client(): Promise<oidc.Configuration> {
    this.discovery ??= oidc
      .discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        undefined,
        clientAuth(this.cfg.tokenAuthMethod, this.cfg.clientSecret),
        this.cfg.allowInsecureIssuer ? { execute: [oidc.allowInsecureRequests] } : undefined,
      )
      .catch((e: unknown) => {
        this.discovery = null;
        throw e;
      });
    return this.discovery;
  }

  private get redirectUri(): string {
    return `${this.publicUrl}/auth/callback`;
  }

  /** Resolves the session cookie; everything except PUBLIC_PATHS requires a session. */
  middleware(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
      c.set('session', null);
      const path = c.req.path;
      if (PUBLIC_PATHS.has(path)) return next();
      const session = this.store.get(getCookie(c, SESSION_COOKIE));
      if (session) {
        c.set('session', session);
        return next();
      }
      if (path.startsWith('/api/')) return c.json({ error: 'sign-in required', login: true }, 401);
      const url = new URL(c.req.url);
      return c.redirect(`/auth/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`);
    };
  }

  /**
   * A valid access token for the session, refreshed when it is about to expire (or always with
   * `force`, after Pingwarden refused the current one).
   */
  async accessToken(s: Session, force = false): Promise<string> {
    if (!force && (s.accessExpiresAt === null || s.accessExpiresAt - REFRESH_MARGIN_MS > Date.now())) {
      return s.accessToken;
    }
    if (!s.refreshToken) {
      this.store.drop(s);
      throw new SessionExpired();
    }
    // One refresh per session at a time: parallel requests share it (refresh tokens may rotate).
    let p = this.refreshing.get(s);
    if (!p) {
      p = this.refresh(s).finally(() => this.refreshing.delete(s));
      this.refreshing.set(s, p);
    }
    return p;
  }

  private async refresh(s: Session): Promise<string> {
    try {
      const tokens = await oidc.refreshTokenGrant(await this.client(), s.refreshToken!);
      s.accessToken = tokens.access_token;
      s.accessExpiresAt = expiry(tokens);
      if (tokens.refresh_token) s.refreshToken = tokens.refresh_token;
      if (tokens.id_token) s.idToken = tokens.id_token;
      // Roles may have changed with the new token: ask Pingwarden again.
      s.access = {};
      return s.accessToken;
    } catch (e) {
      console.warn(`[auth] token refresh failed for ${s.name}: ${(e as Error).message}`);
      this.store.drop(s);
      throw new SessionExpired();
    }
  }

  routes(app: Hono<AppEnv>): void {
    app.get('/auth/login', async (c) => {
      let client: oidc.Configuration;
      try {
        client = await this.client();
      } catch (e) {
        console.error('[auth] OIDC discovery failed:', e);
        return page(c, 502, 'Sign-in unavailable', 'The identity provider could not be reached. Try again later.');
      }
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      this.store.startLogin(state, { codeVerifier, nonce, returnTo: safeReturnTo(c.req.query('returnTo')) });
      // Binds the login to this browser (login CSRF protection).
      setCookie(c, LOGIN_COOKIE, state, {
        httpOnly: true,
        secure: this.secureCookies,
        sameSite: 'Lax',
        path: '/auth/',
        maxAge: 600,
      });
      const url = oidc.buildAuthorizationUrl(client, {
        ...this.cfg.authParams,
        redirect_uri: this.redirectUri,
        scope: this.cfg.scopes,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return c.redirect(url.href);
    });

    app.get('/auth/callback', async (c) => {
      const error = c.req.query('error');
      if (error) {
        return page(c, 401, 'Sign-in failed', `${error}: ${c.req.query('error_description') ?? 'no details'}`);
      }
      const state = getCookie(c, LOGIN_COOKIE);
      deleteCookie(c, LOGIN_COOKIE, { path: '/auth/', secure: this.secureCookies });
      const pending = state ? this.store.takeLogin(state) : null;
      if (!state || !pending) {
        return page(c, 401, 'Sign-in expired', 'The sign-in attempt expired or was started in another browser.');
      }

      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
      try {
        const client = await this.client();
        const current = new URL(this.redirectUri);
        current.search = new URL(c.req.url).search;
        tokens = await oidc.authorizationCodeGrant(client, current, {
          pkceCodeVerifier: pending.codeVerifier,
          expectedState: state,
          expectedNonce: pending.nonce,
          idTokenExpected: true,
        });
      } catch (e) {
        console.error('[auth] token exchange failed:', e);
        return page(c, 401, 'Sign-in failed', 'The identity provider response could not be validated.');
      }
      const claims = tokens.claims()!;
      const name = displayName(claims);

      // Pingwarden is the authority: a user that no instance accepts gets no session at all.
      // Unreachable instances do not block the sign-in (the dashboard shows them as such).
      const answers = await Promise.all(
        this.instances.map((pw) =>
          pw.request('/status', { token: tokens.access_token }).then(
            (r) => ({ pw, r }),
            (e: unknown) => {
              if (!(e instanceof PwUnavailable)) throw e;
              console.error(`[auth] ${e.message}`);
              return { pw, r: null };
            },
          ),
        ),
      );
      const refused = answers.filter((a) => a.r && (a.r.status === 401 || a.r.status === 403));
      if (refused.length === answers.length) {
        const { pw, r } = refused[0]!;
        const why = errorMessage(r!);
        console.warn(`[auth] ${pw.name} refused the access token of ${name} (${r!.status}): ${why}`);
        return page(
          c,
          403,
          'Access denied',
          r!.status === 403
            ? `Pingwarden accepted your sign-in but gives you no read access (${why}). Ask for a role listed in its server.auth.oidc.read or admin.`
            : `Pingwarden did not accept the access token (${why}). Check its server.auth.oidc issuer and audience, and that this client's tokens carry that audience.`,
        );
      }
      if (answers.every((a) => a.r === null)) {
        return page(c, 502, 'Pingwarden unavailable', 'No Pingwarden instance could be reached. Try again later.');
      }

      const token = this.store.create({
        sub: claims.sub,
        name,
        accessToken: tokens.access_token,
        accessExpiresAt: expiry(tokens),
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
        expiresAt: Date.now() + this.cfg.sessionTtlHours * 3600_000,
        access: {},
      });
      setCookie(c, SESSION_COOKIE, token, {
        httpOnly: true,
        secure: this.secureCookies,
        sameSite: 'Lax',
        path: '/',
        maxAge: this.cfg.sessionTtlHours * 3600,
      });
      console.log(`[auth] ${name} signed in`);
      return c.redirect(pending.returnTo);
    });

    app.post('/auth/logout', async (c) => {
      const session = this.store.delete(getCookie(c, SESSION_COOKIE));
      deleteCookie(c, SESSION_COOKIE, { path: '/', secure: this.secureCookies });
      let target = '/auth/logged-out';
      try {
        const client = await this.client();
        // RP-initiated logout ends the provider session too, when supported.
        if (client.serverMetadata().end_session_endpoint) {
          target = oidc.buildEndSessionUrl(client, {
            post_logout_redirect_uri: `${this.publicUrl}/auth/logged-out`,
            ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
          }).href;
        }
      } catch {
        // provider unreachable: local logout only
      }
      return c.redirect(target, 303);
    });

    // Landing page after logout: "/" would sign the user straight in again through SSO.
    app.get('/auth/logged-out', (c) => page(c, 200, 'Signed out', 'You have signed out of Pingwarden.', 'Sign in'));
  }
}

/** Expiry of the access token: expires_in, else the JWT's exp; null when neither is known. */
function expiry(tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers): number | null {
  const inSeconds = tokens.expiresIn();
  if (inSeconds !== undefined) return Date.now() + inSeconds * 1000;
  const exp = jwtClaims(tokens.access_token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : null;
}
