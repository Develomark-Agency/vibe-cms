import { fetchDescriptor, normalizeBranding, PanelError, siteOrigin, type PanelSite } from "vibe-cms/panel";
import { exchangeCode, isAllowed, randomString, verifyIdToken } from "./oidc.ts";
import {
  beginLogin,
  cookie,
  currentSession,
  json,
  LOGIN_COOKIE,
  migrate,
  oidcConfig,
  SESSION_COOKIE,
  SESSION_TTL,
  setCookie,
  siteById,
  type Env,
  type SessionRow
} from "./shared.ts";

import { backupsApi, processBackups } from "./backups.ts";
import { codeFor, hubOrg, hubOrigin, jwks, moveSites, rememberOrigin, syncOrg } from "./hub.ts";
import { hubRecordName, resolveHub } from "vibe-cms/org";
import { handleMcp, siteToken } from "./mcp.ts";
import {
  authorize,
  codePage,
  completeAuthorization,
  corsPreflight,
  decide,
  grantForRequest,
  listAgents,
  oauth,
  protectedResourceMetadata,
  resourceUrl,
  revokeGrant,
  SCOPE_READ,
  type GrantRow
} from "./oauth.ts";
import pkg from "../../package.json" with { type: "json" };

export type { Env } from "./shared.ts";

async function api(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  if(url.pathname === "/api/branding" && request.method === "GET") {
    return json(normalizeBranding({ name: env.PANEL_NAME, accent: env.PANEL_ACCENT, icon: env.PANEL_ICON }), { headers: { "cache-control": "public, max-age=300" } });
  }
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

  const backups = await backupsApi(request, env, session, path, ctx);
  if(backups) return backups;

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
    // The site has to have agreed to trust this hub's org.
    const org = hubOrg(env);
    if(descriptor.org !== org) {
      return json({ error: descriptor.org ? `This site trusts another org (${descriptor.org}), not ${org}` : `This site doesn't belong to an org yet. Set VIBE_ORG=${org} in its environment and deploy it.` }, { status: 422 });
    }
    const site: PanelSite = { id: descriptor.id, url: new URL(descriptor.admin).origin, name: descriptor.name, admin: descriptor.admin, favorite: false };
    await env.DB.prepare(
      `INSERT INTO sites (id, url, name, admin, org, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, name = excluded.name, admin = excluded.admin, org = excluded.org`
    ).bind(site.id, site.url, site.name, site.admin, descriptor.org, session.sub, Date.now()).run();
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

  if(path === "/org" && method === "GET") {
    const { org, previous } = await syncOrg(env);
    const hub = await resolveHub(org, { fresh: true }).catch((error: Error) => ({ error: error.message }));
    const { results } = await env.DB.prepare("SELECT org, COUNT(*) AS sites FROM sites GROUP BY org").all<{ org: string | null, sites: number }>();
    return json({
      org,
      previous,
      // Where the org's DNS record points, and whether that's here.
      record: hubRecordName(org),
      hub: typeof hub === "string" ? hub : null,
      hubError: typeof hub === "string" ? null : hub.error,
      matches: typeof hub === "string" && hub === (await hubOrigin(env) ?? url.origin),
      sites: results
    });
  }

  if(path === "/org/moves" && method === "POST") {
    // Asks sites still on a previous org to move now, rather than at the next cron run.
    return json(await moveSites(env));
  }

  if(path === "/agents" && method === "GET") {
    return json({ mcpUrl: resourceUrl(url), agents: await listAgents(env, session.sub) });
  }

  if((m = /^\/agents\/([^/]+)$/.exec(path)) && method === "DELETE") {
    const grant = await oauth(env).userGrant(session.sub, decodeURIComponent(m[1]!));
    if(!grant) return json({ error: "Unknown agent" }, { status: 404 });
    await revokeGrant(env, grant);
    return new Response(null, { status: 204 });
  }

  if((m = /^\/sites\/([^/]+)\/code$/.exec(path)) && method === "POST") {
    const site = await siteById(env, decodeURIComponent(m[1]!));
    if(!site) return json({ error: "Unknown site" }, { status: 404 });
    return json({ code: await codeFor(env, session, site) });
  }

  return json({ error: "Not found" }, { status: 404 });
}

function login(env: Env, url: URL): Promise<Response> {
  const returnTo = url.searchParams.get("return") ?? "/";
  return beginLogin(env, url, returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/");
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
  if(pending.return_to.startsWith("oauth:")) return completeAuthorization(env, url, pending.return_to.slice(6), claims, tokens);
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

/**
 * `POST /site-token` with an OAuth access token: a session on one site for the connection's user,
 * for clients that call sites directly, like the CLI. `site` is the site's id or URL.
 */
async function siteTokenRoute(request: Request, env: Env, grant: GrantRow): Promise<Response> {
  // A site session can do whatever the user may; a read-only connection can't be held to less.
  if(grant.scope === SCOPE_READ) return json({ error: "This connection is read-only, and site tokens aren't" }, { status: 403 });
  const { site: target } = await request.json().catch(() => ({})) as { site?: string };
  if(!target) return json({ error: "Expected site" }, { status: 400 });
  let site = await siteById(env, target);
  if(!site && URL.canParse(target)) {
    site = await env.DB.prepare("SELECT id, url, name, admin, 0 AS favorite FROM sites WHERE url = ?").bind(siteOrigin(target)).first<PanelSite>();
  }
  if(!site) return json({ error: `${target} isn't in this panel. Add it in the panel first.` }, { status: 404 });
  const session = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(grant.payload).first<SessionRow>();
  if(!session) return json({ error: "This connection's sign-in is gone. Log in again." }, { status: 401 });
  return json({ token: await siteToken(env, grant, session, site), site: { id: site.id, name: site.name, admin: site.admin } });
}

export async function handle(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  await migrate(env.DB);
  try {
    const agentRoutes = ["/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke", "/site-token"];
    if(request.method === "OPTIONS" && (agentRoutes.includes(url.pathname) || url.pathname.startsWith("/.well-known/"))) return corsPreflight();
    if(url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return protectedResourceMetadata(env, url);
    }
    if(url.pathname === "/.well-known/oauth-authorization-server") return oauth(env).authorizationServerMetadata(url);
    // The keys sites verify the hub's tokens with.
    if(url.pathname === "/.well-known/jwks.json") return await jwks(env);
    if(url.pathname === "/oauth/register" && request.method === "POST") return await oauth(env).register(request);
    if(url.pathname === "/oauth/authorize") return await (request.method === "POST" ? decide(request, env, url) : authorize(request, env, url));
    if(url.pathname === "/oauth/token" && request.method === "POST") return await oauth(env).token(request);
    if(url.pathname === "/oauth/revoke" && request.method === "POST") return await oauth(env).revoke(request);
    // Where `vibe-cms login --headless` lands: the code to paste into the terminal.
    if(url.pathname === "/oauth/code" && request.method === "GET") return codePage(url);
    if(url.pathname === "/site-token" && request.method === "POST") {
      const grant = await grantForRequest(request, env);
      if(!grant) return json({ error: "Log in again: this access token is unknown or expired" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      return await siteTokenRoute(request, env, grant);
    }
    if(url.pathname === "/mcp") {
      const grant = await grantForRequest(request, env);
      if(!grant) return oauth(env).unauthorized(url, request.headers.has("authorization"));
      return await handleMcp(request, env, grant, pkg.version);
    }
    if(url.pathname === "/auth/login") return await login(env, url);
    if(url.pathname === "/auth/callback") return await callback(request, env, url);
    if(url.pathname === "/auth/logout" && request.method === "POST") {
      const id = cookie(request, SESSION_COOKIE);
      if(id) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(id).run();
      return new Response(null, { status: 204, headers: { "set-cookie": setCookie(url, SESSION_COOKIE, "", 0) } });
    }
    if(url.pathname.startsWith("/api/")) {
      await rememberOrigin(env, url.origin);
      return await api(request, env, url, ctx);
    }
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

/** Cron: scheduled snapshots, retries, and runs a stopped Worker left behind. */
export async function scheduled(env: Env) {
  await migrate(env.DB);
  await Promise.all([
    moveSites(env).catch(error => console.error("vibe-panel: moving sites to the org failed", error)),
    processBackups(env)
  ]);
}

export default {
  fetch: handle,
  scheduled: (_event, env, ctx) => ctx.waitUntil(scheduled(env))
} satisfies ExportedHandler<Env>;
