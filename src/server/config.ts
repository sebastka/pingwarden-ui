// Configuration from the environment. Everything is validated at startup: a mistake stops the
// server with a list of every problem rather than surfacing later as a confusing error.
import { resolve } from 'node:path';
import type { AuthMode } from '../shared/types.ts';

type Env = Record<string, string | undefined>;

/** Client authentication methods at the token endpoint (RFC 8414 names). */
export const TOKEN_AUTH_METHODS = ['client_secret_basic', 'client_secret_post', 'client_secret_jwt', 'none'] as const;
export type TokenAuthMethod = (typeof TOKEN_AUTH_METHODS)[number];

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  tokenAuthMethod: TokenAuthMethod;
  scopes: string;
  /** Extra authorization request parameters, e.g. audience=pingwarden or resource=… */
  authParams: Record<string, string>;
  /** Accept an http:// issuer (development against a local mock provider). */
  allowInsecureIssuer: boolean;
  sessionTtlHours: number;
}

/** One Pingwarden instance (PINGWARDEN_<n>_*, or the PINGWARDEN_URL shorthand). */
export interface InstanceConfig {
  /** Stable id in URLs and API paths. */
  id: string;
  name: string;
  /** Base URL, without /api/v1. */
  url: string;
  /** Static API token (AUTH_MODE=token); null = none (Pingwarden's anonymous_read). */
  token: string | null;
}

export interface Config {
  http: {
    host: string;
    port: number;
    /** External URL of the UI; required with OIDC (redirect URI, secure cookies). */
    publicUrl: string | null;
    /** Host header values accepted besides localhost and PUBLIC_URL's host; ["*"] = any. */
    allowedHosts: string[];
    /** Origins that may embed the dashboard in a frame (CSP frame-ancestors); [] = none. */
    frameAncestors: string[];
  };
  /** At least one; the first is the one the UI opens. */
  instances: InstanceConfig[];
  pingwardenTimeoutMs: number;
  auth: { mode: AuthMode; oidc: OidcConfig | null };
  /** Never relay runtime actions (run now, pause, acknowledge, silence, maintenance, test, reload). */
  readOnly: boolean;
  refreshSeconds: number;
  staticDir: string;
}

function str(env: Env, name: string, fallback?: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : fallback;
}

function int(env: Env, name: string, fallback: number, errors: string[], min = 0): number {
  const v = str(env, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) {
    errors.push(`${name} must be an integer ≥ ${min}, got "${v}"`);
    return fallback;
  }
  return n;
}

function bool(env: Env, name: string, fallback: boolean, errors: string[]): boolean {
  const v = str(env, name)?.toLowerCase();
  if (v === undefined) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  errors.push(`${name} must be true or false, got "${v}"`);
  return fallback;
}

function list(env: Env, name: string): string[] {
  return (env[name] ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function url(env: Env, name: string, errors: string[], required = false): string | null {
  const v = str(env, name);
  if (!v) {
    if (required) errors.push(`${name} is required`);
    return null;
  }
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error();
    return v.replace(/\/+$/, '');
  } catch {
    errors.push(`${name} must be an http(s) URL, got "${v}"`);
    return null;
  }
}

function oidc(env: Env, errors: string[], publicUrl: string | null): OidcConfig {
  if (!publicUrl)
    errors.push('PUBLIC_URL is required with AUTH_MODE=oidc (the redirect URI is PUBLIC_URL/auth/callback)');
  const issuer = url(env, 'OIDC_ISSUER', errors, true) ?? '';
  const allowInsecureIssuer = bool(env, 'OIDC_ALLOW_INSECURE_ISSUER', false, errors);
  if (issuer.startsWith('http://') && !allowInsecureIssuer) {
    errors.push('OIDC_ISSUER must use https (set OIDC_ALLOW_INSECURE_ISSUER=true for a local test provider)');
  }
  const clientId = str(env, 'OIDC_CLIENT_ID');
  if (!clientId) errors.push('OIDC_CLIENT_ID is required');
  const clientSecret = str(env, 'OIDC_CLIENT_SECRET') ?? null;
  const method = str(env, 'OIDC_TOKEN_AUTH_METHOD', clientSecret ? 'client_secret_basic' : 'none')!;
  if (!(TOKEN_AUTH_METHODS as readonly string[]).includes(method)) {
    errors.push(`OIDC_TOKEN_AUTH_METHOD must be one of ${TOKEN_AUTH_METHODS.join(', ')}, got "${method}"`);
  } else if (method !== 'none' && !clientSecret) {
    errors.push(`OIDC_TOKEN_AUTH_METHOD=${method} needs OIDC_CLIENT_SECRET`);
  }
  const authParams: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(str(env, 'OIDC_AUTH_PARAMS', ''))) authParams[k] = v;
  const reserved = Object.keys(authParams).filter((k) =>
    ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'nonce', 'code_challenge'].includes(k),
  );
  if (reserved.length) errors.push(`OIDC_AUTH_PARAMS may not set ${reserved.join(', ')}`);
  for (const gone of ['OIDC_ROLES_CLAIM', 'OIDC_ADMIN_ROLES']) {
    if (str(env, gone)) errors.push(`${gone} is no longer used: Pingwarden's /api/v1/me tells who may act`);
  }
  return {
    issuer,
    clientId: clientId ?? '',
    clientSecret,
    tokenAuthMethod: method as TokenAuthMethod,
    scopes: str(env, 'OIDC_SCOPES', 'openid profile email')!,
    authParams,
    allowInsecureIssuer,
    sessionTtlHours: int(env, 'SESSION_TTL_HOURS', 12, errors, 1),
  };
}

/** The numbers n for which some <PREFIX>_<n>_* variable is set, in ascending order. */
function numbers(env: Env, prefix: string): number[] {
  const ns = new Set<number>();
  const re = new RegExp(`^${prefix}_(\\d+)_[A-Z0-9_]+$`);
  for (const key of Object.keys(env)) {
    const m = re.exec(key);
    if (m && env[key]?.trim()) ns.add(Number(m[1]));
  }
  return [...ns].sort((a, b) => a - b);
}

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/**
 * Pingwarden instances: numbered blocks PINGWARDEN_<n>_URL, _NAME, _ID, _TOKEN, or for a single
 * instance PINGWARDEN_URL (and PINGWARDEN_NAME, PINGWARDEN_TOKEN), which is block "main".
 */
function instances(env: Env, errors: string[], mode: string | undefined): InstanceConfig[] {
  const ns = numbers(env, 'PINGWARDEN');
  const single = str(env, 'PINGWARDEN_URL');
  if (single && ns.length) errors.push('set either PINGWARDEN_URL or numbered PINGWARDEN_<n>_URL blocks, not both');
  const blocks = ns.length
    ? ns.map((n) => ({ prefix: `PINGWARDEN_${n}_`, id: String(n) }))
    : [{ prefix: 'PINGWARDEN_', id: 'main' }];
  const ids = new Set<string>();
  return blocks.map(({ prefix, id: fallbackId }) => {
    const u = url(env, `${prefix}URL`, errors, true)?.replace(/\/api\/v1$/, '') ?? '';
    const id = str(env, `${prefix}ID`, fallbackId)!.toLowerCase();
    if (!INSTANCE_ID_RE.test(id)) errors.push(`${prefix}ID must be lowercase letters, digits, "-" or "_", got "${id}"`);
    if (ids.has(id)) errors.push(`${prefix}ID "${id}" is used by two instances`);
    ids.add(id);
    const token = str(env, `${prefix}TOKEN`) ?? null;
    if (mode === 'oidc' && token) {
      errors.push(`${prefix}TOKEN is only used with AUTH_MODE=token; with OIDC every request carries the user's token`);
    }
    let name = str(env, `${prefix}NAME`);
    if (!name) {
      try {
        name = new URL(u).host;
      } catch {
        name = id;
      }
    }
    return { id, name, url: u, token };
  });
}

/** `https://a.example, http://localhost:8123` → validated origins for CSP frame-ancestors. */
function origins(env: Env, name: string, errors: string[]): string[] {
  return list(env, name).flatMap((o) => {
    try {
      const u = new URL(o);
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === o.replace(/\/$/, '')) return [u.origin];
    } catch {
      // reported below
    }
    errors.push(`${name}: "${o}" is not an origin (scheme://host[:port], without path)`);
    return [];
  });
}

export function loadConfig(env: Env = process.env): Config {
  const errors: string[] = [];
  const mode = str(env, 'AUTH_MODE');
  if (mode !== 'oidc' && mode !== 'token') {
    errors.push(
      `AUTH_MODE must be "oidc" (users sign in) or "token" (no login, the UI uses PINGWARDEN_TOKEN), got "${mode ?? ''}"`,
    );
  }
  const publicUrl = url(env, 'PUBLIC_URL', errors);

  const cfg: Config = {
    http: {
      host: str(env, 'LISTEN_HOST', '127.0.0.1')!,
      port: int(env, 'PORT', 3000, errors, 1),
      publicUrl,
      allowedHosts: list(env, 'ALLOWED_HOSTS').map((h) => h.toLowerCase()),
      frameAncestors: origins(env, 'FRAME_ANCESTORS', errors),
    },
    instances: instances(env, errors, mode),
    pingwardenTimeoutMs: int(env, 'PINGWARDEN_TIMEOUT_SECONDS', 10, errors, 1) * 1000,
    auth: { mode: mode === 'oidc' ? 'oidc' : 'token', oidc: mode === 'oidc' ? oidc(env, errors, publicUrl) : null },
    // Without a login anyone who reaches the dashboard could pause monitors: read-only by default.
    readOnly: bool(env, 'READ_ONLY', mode !== 'oidc', errors),
    refreshSeconds: int(env, 'REFRESH_SECONDS', 15, errors, 2),
    staticDir: resolve(str(env, 'STATIC_DIR', resolve(import.meta.dirname, '../../dist/web'))!),
  };
  if (errors.length) throw new ConfigError(errors);
  return cfg;
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}
