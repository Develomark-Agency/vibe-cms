import { decodeJwt } from "jose";
import { fetchDescriptor, PanelError, type PanelSite } from "vibe-cms/panel";
import { authorizationUrl, exchangeCode, isAllowed, randomString, refresh, verifyIdToken, type OidcConfig } from "./oidc.ts";

export interface Env {
  DB: D1Database,
  ASSETS?: Fetcher,
  OIDC_ISSUER: string,
  OIDC_CLIENT_ID: string,
  OIDC_CLIENT_SECRET: string,
  /** Comma-separated email domains or group claim values allowed to use the panel. */
  PANEL_ALLOW?: string,
  OIDC_SCOPES?: string
}

interface SessionRow {
  id: string,
  sub: string,
  email: string | null,
  name: string | null,
  id_token: string,
  refresh_token: string | null,
  expires_at: number
}

const SESSION_COOKIE = "panel_session";
const LOGIN_COOKIE = "panel_login";
const SESSION_TTL = 30 * 24 * 3600 * 1000;

const schema = [
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
  )`
];

const migrated = new WeakSet<D1Database>();

async function migrate(db: D1Database) {
  if(migrated.has(db)) return;
  await db.batch(schema.map(sql => db.prepare(sql)));
  migrated.add(db);
}

function oidcConfig(env: Env): OidcConfig {
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

function json(data: unknown, init: ResponseInit = {}) {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...init.headers } });
}

function cookie(request: Request, name: string): string | undefined {
  for(const part of (request.headers.get("cookie") ?? "").split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if(key === name) return rest.join("=");
  }
  return undefined;
}

function setCookie(url: URL, name: string, value: string, maxAge: number, sameSite = "Lax") {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`;
}

async function currentSession(request: Request, env: Env): Promise<SessionRow | null> {
  const id = cookie(request, SESSION_COOKIE);
  if(!id) return null;
  const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first<SessionRow>();
  if(!row || row.expires_at < Date.now()) return null;
  return row;
}

/** The provider ID token for the handoff, refreshed when it's about to expire. */
async function freshIdToken(env: Env, session: SessionRow): Promise<string> {
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
async function codeFor(env: Env, session: SessionRow, site: PanelSite): Promise<string> {
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

async function siteById(env: Env, id: string): Promise<PanelSite | null> {
  return env.DB.prepare("SELECT id, url, name, admin, 0 AS favorite FROM sites WHERE id = ?").bind(id).first<PanelSite>();
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await currentSession(request, env);
  if(!session) return json({ error: "Not signed in" }, { status: 401 });
  const path = url.pathname.slice(4);
  const method = request.method;
  let m: RegExpExecArray | null;

  // Browsers only reach the API from the panel's own pages.
  if(method !== "GET" && request.headers.get("origin") && request.headers.get("origin") !== url.origin) {
    return json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  if(path === "/me" && method === "GET") return json({ name: session.name, email: session.email });

  if(path === "/sites" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.url, s.name, s.admin, f.user IS NOT NULL AS favorite FROM sites s
       LEFT JOIN favorites f ON f.site_id = s.id AND f.user = ? ORDER BY s.name`
    ).bind(session.sub).all<Omit<PanelSite, "favorite"> & { favorite: number }>();
    return json(results.map(r => ({ ...r, favorite: Boolean(r.favorite) })));
  }

  if(path === "/sites" && method === "POST") {
    const { url: siteUrl } = await request.json() as { url?: string };
    const descriptor = await fetchDescriptor(siteUrl ?? "");
    const config = oidcConfig(env);
    // The site has to have agreed to trust this panel's identity provider.
    if(descriptor.auth?.issuer.replace(/\/$/, "") !== config.issuer.replace(/\/$/, "") || descriptor.auth.clientId !== config.clientId) {
      return json({ error: "This site trusts a different identity provider" }, { status: 422 });
    }
    const site: PanelSite = { id: descriptor.id, url: new URL(descriptor.admin).origin, name: descriptor.name, admin: descriptor.admin, favorite: false };
    await env.DB.prepare(
      `INSERT INTO sites (id, url, name, admin, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, name = excluded.name, admin = excluded.admin`
    ).bind(site.id, site.url, site.name, site.admin, session.sub, Date.now()).run();
    return json(site, { status: 201 });
  }

  if((m = /^\/sites\/([^/]+)$/.exec(path)) && method === "DELETE") {
    const id = decodeURIComponent(m[1]!);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM favorites WHERE site_id = ?").bind(id),
      env.DB.prepare("DELETE FROM sites WHERE id = ?").bind(id)
    ]);
    return new Response(null, { status: 204 });
  }

  if((m = /^\/sites\/([^/]+)\/favorite$/.exec(path)) && (method === "PUT" || method === "DELETE")) {
    const id = decodeURIComponent(m[1]!);
    if(method === "PUT") {
      await env.DB.prepare("INSERT OR IGNORE INTO favorites (user, site_id) VALUES (?, ?)").bind(session.sub, id).run();
    } else {
      await env.DB.prepare("DELETE FROM favorites WHERE user = ? AND site_id = ?").bind(session.sub, id).run();
    }
    return new Response(null, { status: 204 });
  }

  if((m = /^\/sites\/([^/]+)\/code$/.exec(path)) && method === "POST") {
    const site = await siteById(env, decodeURIComponent(m[1]!));
    if(!site) return json({ error: "Unknown site" }, { status: 404 });
    return json({ code: await codeFor(env, session, site) });
  }

  return json({ error: "Not found" }, { status: 404 });
}

async function login(env: Env, url: URL): Promise<Response> {
  const config = oidcConfig(env);
  const state = randomString();
  const nonce = randomString();
  const verifier = randomString(48);
  const returnTo = url.searchParams.get("return") ?? "/";
  await env.DB.prepare("DELETE FROM logins WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare("INSERT INTO logins (state, verifier, nonce, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(state, verifier, nonce, returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/", Date.now() + 600_000).run();
  const location = await authorizationUrl(config, { redirectUri: `${url.origin}/auth/callback`, state, nonce, verifier });
  return new Response(null, {
    status: 302,
    // Binds the login to this browser, so a stolen callback URL can't sign someone else in.
    headers: { location, "set-cookie": setCookie(url, LOGIN_COOKIE, state, 600) }
  });
}

async function callback(request: Request, env: Env, url: URL): Promise<Response> {
  function fail(message: string) {
    return Response.redirect(`${url.origin}/?error=${encodeURIComponent(message)}`, 302);
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if(url.searchParams.get("error")) return fail(url.searchParams.get("error_description") ?? url.searchParams.get("error")!);
  if(!state || !code || cookie(request, LOGIN_COOKIE) !== state) return fail("Sign-in expired. Try again.");
  const pending = await env.DB.prepare("DELETE FROM logins WHERE state = ? RETURNING *").bind(state)
    .first<{ verifier: string, nonce: string, return_to: string, expires_at: number }>();
  if(!pending || pending.expires_at < Date.now()) return fail("Sign-in expired. Try again.");
  const config = oidcConfig(env);
  let claims;
  let tokens;
  try {
    tokens = await exchangeCode(config, { code, redirectUri: `${url.origin}/auth/callback`, verifier: pending.verifier });
    claims = await verifyIdToken(config, tokens.id_token, pending.nonce);
  } catch (error) {
    return fail(`Sign-in failed: ${(error as Error).message}`);
  }
  if(!isAllowed(env.PANEL_ALLOW, claims)) return fail("Your account isn't allowed to use this panel.");
  const id = randomString();
  await env.DB.prepare("INSERT INTO sessions (id, sub, email, name, id_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(
      id,
      `${claims.iss}|${claims.sub}`,
      typeof claims.email === "string" ? claims.email : null,
      typeof claims.name === "string" ? claims.name : null,
      tokens.id_token,
      tokens.refresh_token ?? null,
      Date.now() + SESSION_TTL
    ).run();
  const headers = new Headers({ location: `${url.origin}${pending.return_to}` });
  headers.append("set-cookie", setCookie(url, SESSION_COOKIE, id, SESSION_TTL / 1000));
  headers.append("set-cookie", setCookie(url, LOGIN_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

/** Full-page handoff: `edit.my-agency.com/go/<siteId>` → the site's editor, signed in. */
async function goTo(request: Request, env: Env, url: URL, siteId: string): Promise<Response> {
  const session = await currentSession(request, env);
  if(!session) return Response.redirect(`${url.origin}/auth/login?return=${encodeURIComponent(url.pathname)}`, 302);
  const site = await siteById(env, siteId);
  if(!site) return Response.redirect(`${url.origin}/?error=${encodeURIComponent("Unknown site")}`, 302);
  try {
    const code = await codeFor(env, session, site);
    // The code rides in the fragment, which never reaches a server.
    return Response.redirect(`${site.admin}/#code=${encodeURIComponent(code)}`, 302);
  } catch (error) {
    return Response.redirect(`${url.origin}/?error=${encodeURIComponent((error as Error).message)}`, 302);
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  await migrate(env.DB);
  try {
    if(url.pathname === "/auth/login") return await login(env, url);
    if(url.pathname === "/auth/callback") return await callback(request, env, url);
    if(url.pathname === "/auth/logout" && request.method === "POST") {
      const id = cookie(request, SESSION_COOKIE);
      if(id) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
      return new Response(null, { status: 204, headers: { "set-cookie": setCookie(url, SESSION_COOKIE, "", 0) } });
    }
    const go = /^\/go\/([^/]+)\/?$/.exec(url.pathname);
    if(go) return await goTo(request, env, url, decodeURIComponent(go[1]!));
    if(url.pathname.startsWith("/api/")) return await api(request, env, url);
  } catch (error) {
    if(error instanceof PanelError) return json({ error: error.message }, { status: error.status });
    console.error(error);
    return json({ error: "Internal error" }, { status: 500 });
  }
  if(env.ASSETS) {
    // Single-page app: unknown paths get index.html.
    let response = await env.ASSETS.fetch(request);
    if(response.status === 404) response = await env.ASSETS.fetch(new Request(new URL("/", url), request));
    // The panel frames sites; nothing gets to frame the panel.
    const headers = new Headers(response.headers);
    headers.set("x-frame-options", "DENY");
    headers.set("content-security-policy", "frame-ancestors 'none'");
    return new Response(response.body, { status: response.status, headers });
  }
  return new Response("Not found", { status: 404 });
}

export default {
  fetch: handle
} satisfies ExportedHandler<Env>;
