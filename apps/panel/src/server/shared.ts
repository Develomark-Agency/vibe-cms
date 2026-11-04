import { decodeJwt } from "jose";
import { eq, lt } from "drizzle-orm";
import { createDb, runMigrations } from "vibe-cms/db";
import { PanelError, type PanelSite } from "vibe-cms/panel";
import { migrations } from "../../migrations/index.ts";
import { logins, sessions, sites } from "./schema.ts";
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
  /** The panel's public address, for links and OAuth. Learned from requests when unset. */
  PANEL_URL?: string,
  /**
   * The org this hub signs for: a domain you own, like `my-org.com`, whose `_vibe-hub` TXT record holds
   * this hub's address. Sites trust the same value in their own `VIBE_ORG`.
   */
  VIBE_ORG?: string,
  /** Secret: the hub's private ES256 signing key as JWK JSON, from `bunx vibe-cms hub keygen`. */
  HUB_SIGNING_KEY?: string,
  /** Identity provider claim whose values sites receive as `roles`, e.g. `groups`. */
  OIDC_ROLES_CLAIM?: string
}

export type { SessionRow } from "./schema.ts";
import type { SessionRow } from "./schema.ts";

export const SESSION_COOKIE = "panel_session";
export const LOGIN_COOKIE = "panel_login";
export const SESSION_TTL = 30 * 24 * 3600 * 1000;

type D1Like = Parameters<typeof createDb>[0];

/** The typed query builder over the panel's D1 binding. */
export function db(env: Env) {
  return createDb(env.DB as unknown as D1Like);
}

/** Tokens and codes are stored as hashes, so a leaked database doesn't leak working credentials. */
export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
}

const migrated = new WeakSet<D1Database>();

export async function migrate(d1: D1Database) {
  if(migrated.has(d1)) return;
  await runMigrations(d1 as unknown as D1Like, migrations, "panel_migrations");
  // Panels made before sites recorded their org.
  await d1.prepare("ALTER TABLE sites ADD COLUMN org TEXT").run().catch(() => {});
  // The signing key is a Worker secret now; one left in the database is only a liability.
  await d1.prepare("DELETE FROM panel_meta WHERE key = 'signing_key'").run();
  // Connections moved to oauth_grants (vibe-cms/oauth); agents connected before reconnect once.
  await d1.prepare("DROP TABLE IF EXISTS agent_grants").run();
  migrated.add(d1);
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
  const [row] = await db(env).select().from(sessions).where(eq(sessions.id, id));
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
  await db(env).update(sessions)
    .set({ id_token: tokens.id_token, refresh_token: tokens.refresh_token ?? session.refresh_token })
    .where(eq(sessions.id, session.id));
  return tokens.id_token;
}

export async function siteById(env: Env, id: string): Promise<PanelSite | null> {
  const [row] = await db(env).select({ id: sites.id, url: sites.url, name: sites.name, admin: sites.admin }).from(sites).where(eq(sites.id, id));
  return row ? { ...row, favorite: false } : null;
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
  await db(env).delete(logins).where(lt(logins.expires_at, Date.now()));
  await db(env).insert(logins).values({ state, verifier, nonce, return_to: returnTo, expires_at: Date.now() + 600_000 });
  const location = await authorizationUrl(config, { redirectUri: `${url.origin}/auth/callback`, state, nonce, verifier, loginHint });
  return new Response(null, {
    status: 302,
    // Binds the login to this browser, so a stolen callback URL can't sign someone else in.
    headers: { location, "set-cookie": setCookie(url, LOGIN_COOKIE, state, 600) }
  });
}
