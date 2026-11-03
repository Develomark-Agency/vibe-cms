import { decodeJwt } from "jose";
import { PanelError, type PanelSite } from "vibe-cms/panel";
import { backupSchema } from "./backups.ts";
import { authorizationUrl, randomString, refresh, verifyIdToken, type OidcConfig } from "./oidc.ts";

export interface Env {
  DB: D1Database,
  ASSETS?: Fetcher,
  OIDC_ISSUER: string,
  OIDC_CLIENT_ID: string,
  OIDC_CLIENT_SECRET: string,
  /** Comma-separated email domains or group claim values allowed to use the panel. */
  PANEL_ALLOW?: string,
  OIDC_SCOPES?: string,
  /** White-labelling: the panel's name, accent (`#rrggbb`) and logo URL. */
  PANEL_NAME?: string,
  PANEL_ACCENT?: string,
  PANEL_ICON?: string,
  /** The archive for scheduled backups. Without it, the panel doesn't back sites up. */
  BACKUPS?: R2Bucket,
  /** The panel's public address, which sites name in `backups.panel`. Learned from requests when unset. */
  PANEL_URL?: string
}

export interface SessionRow {
  id: string,
  sub: string,
  email: string | null,
  name: string | null,
  id_token: string,
  refresh_token: string | null,
  expires_at: number
}

export const SESSION_COOKIE = "panel_session";
export const LOGIN_COOKIE = "panel_login";
export const SESSION_TTL = 30 * 24 * 3600 * 1000;

export const schema = [
  `CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    admin TEXT NOT NULL,
    added_by TEXT NOT NULL,
    added_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS favorites (
    user TEXT NOT NULL,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    PRIMARY KEY (user, site_id)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sub TEXT NOT NULL,
    email TEXT,
    name TEXT,
    id_token TEXT NOT NULL,
    refresh_token TEXT,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS logins (
    state TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    return_to TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // Agents (MCP clients) that registered themselves with the panel's OAuth server.
  `CREATE TABLE IF NOT EXISTS oauth_clients (
    id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    uri TEXT,
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  // An authorization in progress: from the agent's /oauth/authorize to the code.
  `CREATE TABLE IF NOT EXISTS oauth_requests (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    state TEXT,
    scope TEXT NOT NULL,
    user TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS oauth_codes (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // A connected agent. It has its own provider sign-in (session_id), so signing out of the panel doesn't disconnect it.
  `CREATE TABLE IF NOT EXISTS agent_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    user TEXT NOT NULL,
    session_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    access_hash TEXT UNIQUE,
    access_expires_at INTEGER,
    refresh_hash TEXT UNIQUE,
    refresh_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  // Site sessions the panel holds for an agent, one per site, until they expire.
  `CREATE TABLE IF NOT EXISTS agent_site_tokens (
    grant_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (grant_id, site_id)
  )`
];

/** Tokens and codes are stored as hashes, so a leaked database doesn't leak working credentials. */
export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
}

const migrated = new WeakSet<D1Database>();

export async function migrate(db: D1Database) {
  if(migrated.has(db)) return;
  await db.batch([...schema, ...backupSchema].map(sql => db.prepare(sql)));
  migrated.add(db);
}

export function oidcConfig(env: Env): OidcConfig {
  if(!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID || !env.OIDC_CLIENT_SECRET) {
    throw new PanelError(500, "The panel needs OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET");
  }
  return {
    issuer: env.OIDC_ISSUER,
    clientId: env.OIDC_CLIENT_ID,
    clientSecret: env.OIDC_CLIENT_SECRET,
    scopes: env.OIDC_SCOPES ?? "openid email profile"
  };
}

export function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...init.headers } });
}

export function cookie(request: Request, name: string): string | undefined {
  for(const part of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if(key === name) return rest.join("=");
  }
  return undefined;
}

export function setCookie(url: URL, name: string, value: string, maxAge: number, sameSite = "Lax") {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}

export async function currentSession(request: Request, env: Env): Promise<SessionRow | null> {
  const id = cookie(request, SESSION_COOKIE);
  if(!id) return null;
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if(!row || row.expires_at < Date.now()) return null;
  return row;
}

/** The provider ID token for the handoff, refreshed when it's about to expire. */
export async function freshIdToken(env: Env, session: SessionRow): Promise<string> {
  const exp = decodeJwt(session.id_token).exp ?? 0;
  if(exp * 1000 > Date.now() + 60_000) return session.id_token;
  if(!session.refresh_token) throw new PanelError(401, "Your sign-in expired. Sign in again.");
  const config = oidcConfig(env);
  const tokens = await refresh(config, session.refresh_token).catch(() => {
    throw new PanelError(401, "Your sign-in expired. Sign in again.");
  });
  await verifyIdToken(config, tokens.id_token);
  await env.DB.prepare("UPDATE sessions SET id_token = ?, refresh_token = COALESCE(?, refresh_token) WHERE id = ?")
    .bind(tokens.id_token, tokens.refresh_token ?? null, session.id).run();
  return tokens.id_token;
}

/** Panel → site, server to server: provider ID token in, one-time code out. */
export async function codeFor(env: Env, session: SessionRow, site: PanelSite): Promise<string> {
  const endpoint = `${site.admin.replace(/\/admin\/?$/, "")}/api/session/code`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: await freshIdToken(env, session) })
  });
  const data = await response.json().catch(() => ({})) as { code?: string, error?: string };
  if(!response.ok || !data.code) {
    throw new PanelError(response.status === 403 ? 403 : 502, data.error ?? `The site refused the sign-in (${response.status})`);
  }
  return data.code;
}

export async function siteById(env: Env, id: string): Promise<PanelSite | null> {
  return env.DB.prepare("SELECT id, url, name, admin, 0 AS favorite FROM sites WHERE id = ?").bind(id).first<PanelSite>();
}

/**
 * Sends the browser to the identity provider. `returnTo` is a panel path, or
 * `oauth:<request>` when the sign-in is for connecting an agent.
 */
export async function beginLogin(env: Env, url: URL, returnTo: string, loginHint?: string): Promise<Response> {
  const config = oidcConfig(env);
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);
  await env.DB.prepare("DELETE FROM logins WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO logins (state, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(state, verifier, nonce, returnTo, Date.now() + 600_000).run();
  const location = await authorizationUrl(config, { redirectUri: `${url.origin}/auth/callback`, state, nonce, verifier, loginHint });
  return new Response(null, {
    status: 302,
    // Binds the login to this browser, so a stolen callback URL can't sign someone else in.
    headers: { location, "set-cookie": setCookie(url, LOGIN_COOKIE, state, 600) }
  });
}
