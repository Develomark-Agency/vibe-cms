import { HttpError, serializeConfig, type AnyConfig } from "../config.ts";
import type { SerializedQuery } from "../query/index.ts";
import type { Session } from "../server/index.ts";
import { consumeCode, createCode, DEV_SESSION, issueSession, permissionSummary, require, sessionFromHubToken, verifySession } from "./auth.ts";
import type { OrgStatus } from "../org/index.ts";
import * as oauth from "./oauth.ts";
import {
  announceSetup,
  cookieIdentity,
  authenticate,
  authenticationOptions,
  invite,
  listUsers,
  needsSetup,
  oidcCallback,
  oidcLogin,
  register,
  registrationOptions,
  removeUser,
  resume,
  SIGNIN_COOKIE,
  signInMode,
  signOut,
  updateUser
} from "./signin.ts";
import { coreActions, type CoreActions } from "../actions/core.ts";
import { runAction, type AnyAction } from "../actions/define.ts";
import { errorJson, fromHttpError, httpStatus, type ActionError } from "../actions/errors.ts";
import { describeActions, filesFromJson } from "../actions/describe.ts";
import { fromText } from "../actions/inputs.ts";
import { Engine, type EngineState, type SiteSettings } from "./engine.ts";
import { transferRoute } from "./backups.ts";
import { handleMcp } from "./mcp.ts";
import type { ExecutionContext, Fetcher } from "./platform.ts";
import { matchRoute } from "./plugins.ts";
import { PREVIEW_TTL, previewCookie, previewScriptResponse, previewWindowResponse, safePath } from "./preview.ts";

export interface ApiContext {
  state: EngineState,
  dev: boolean,
  assets: Fetcher | undefined,
  ctx: ExecutionContext
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for(const part of header.split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if(key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** A site session token, or a token the hub signed for this site, as `Authorization: Bearer`. */
async function readSession(request: Request, api: ApiContext): Promise<Session | null> {
  const header = request.headers.get("authorization");
  if(!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  return await verifySession(api.state.db, token, api.state.siteId)
    ?? await oauth.grantSession(api.state, token)
    ?? await sessionFromHubToken(api.state, token);
}

async function body<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return new Response(response.body, { status: response.status, headers });
}

export function descriptor(config: AnyConfig, url: URL, prefix: string, site: SiteSettings, org: OrgStatus) {
  return {
    protocol: 1,
    id: site.id,
    name: site.name,
    accent: site.accent,
    icon: site.icon?.url ?? site.favicon,
    /** The org whose hub the site trusts (`VIBE_ORG`), and the hub's address. */
    org: org.org,
    hub: org.hub,
    /** A pending move to another org, which takes effect at `effectiveAt` unless cancelled. */
    orgMove: org.move,
    backups: config.backups === true,
    admin: `${url.origin}${prefix}/admin`
  };
}

/** Handles everything under the prefix. Returns null for paths the CMS doesn't own. */
export async function handleRequest(request: Request, api: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const { config, prefix } = api.state;
  if(url.pathname === "/.well-known/vibe-cms") {
    const site = await new Engine(api.state, { origin: url.origin, session: null, trusted: false, ctx: api.ctx }).site();
    return cors(json(descriptor(config, url, prefix, site, await api.state.org.status()), { headers: { "cache-control": "public, max-age=60" } }));
  }
  const path = url.pathname.slice(prefix.length) || "/";
  const method = request.method.toUpperCase();
  try {
    // The site as an OAuth server for agents and the CLI, when it signs people in itself.
    const known = oauth.wellKnownPaths(prefix);
    const isServerMetadata = known.authorizationServer.includes(url.pathname);
    const isResourceMetadata = known.protectedResource.includes(url.pathname);
    const oauthRoute = /^\/oauth\/(register|authorize|token|revoke|code)$/.exec(path)?.[1];
    if(isServerMetadata || isResourceMetadata || oauthRoute) {
      // In development, agents and the CLI get in as the developer without signing in.
      if(api.dev) return json({ error: "Development sites let agents and the CLI in without signing in" }, { status: 404 });
      if(!await oauth.servesOAuth(api.state)) return json({ error: "This site signs agents and the CLI in through its org's hub" }, { status: 404 });
      if(method === "OPTIONS") return oauth.corsPreflight();
      if(isServerMetadata) return oauth.authorizationServerMetadata(api.state, url);
      if(isResourceMetadata) {
        const site = await new Engine(api.state, { origin: url.origin, session: null, trusted: false, ctx: api.ctx }).site();
        return oauth.protectedResourceMetadata(api.state, url, site.name);
      }
      if(oauthRoute === "register" && method === "POST") return await oauth.register(api.state, request);
      if(oauthRoute === "authorize" && method === "GET") return await oauth.authorize(api.state, url);
      if(oauthRoute === "token" && method === "POST") return await oauth.token(api.state, request);
      if(oauthRoute === "revoke" && method === "POST") return await oauth.revoke(api.state, request);
      if(oauthRoute === "code" && method === "GET") return oauth.codePage(url);
      return json({ error: "Not found" }, { status: 404 });
    }
    if(path === "/admin" || path.startsWith("/admin/")) return await serveAdmin(request, api, url);
    if(path === "/preview.js" && method === "GET") return previewScriptResponse(prefix);
    if(path === "/preview" && method === "GET") return await startPreview(api, url);
    if(path === "/preview/window" && method === "GET") return previewWindowResponse(prefix, safePath(url.searchParams.get("path")));
    if(path === "/preview/exit" && method === "GET") {
      return redirect(url, safePath(url.searchParams.get("path")), previewCookie("", 0, url.protocol === "https:"));
    }
    // Signed links from the backup actions; the signature stands in for a session.
    if(path.startsWith("/api/backups/files/")) {
      const key = path.slice(19).split("/").map(decodeURIComponent).join("/");
      return cors(await transferRoute(request, api.state.db, api.state.storage, url, key));
    }
    // A site nobody owns yet prints its one-time setup link to its logs.
    if(!api.dev) api.ctx.waitUntil?.(announceSetup(api.state, url.origin).catch(() => {}));
    const session = await readSession(request, api);
    const engine = new Engine(api.state, { origin: url.origin, session, trusted: false, ctx: api.ctx });

    if(path.startsWith("/media/") && method === "GET") return await engine.serveAsset(path.slice(7), request);

    const plugin = /^\/plugins\/([\w-]+)(\/.*)?$/.exec(path);
    if(plugin) return await pluginRoute(request, api, plugin[1]!, plugin[2] ?? "/", session);

    if(!path.startsWith("/api/")) return json({ error: "Not found" }, { status: 404 });
    const route = path.slice(4);

    if(route === "/query") {
      if(method === "OPTIONS") return cors(new Response(null, { status: 204 }));
      if(method !== "POST") throw new HttpError(405, "Use POST");
      const { queries } = await body<{ queries: SerializedQuery[] }>(request);
      if(!Array.isArray(queries) || queries.length > 50) throw new HttpError(400, "Expected 1-50 queries");
      return cors(json({ results: await engine.execute(queries) }));
    }

    if(route === "/mcp") {
      if(method === "OPTIONS") return oauth.corsPreflight();
      // Development sites let local agents in as the developer, like the editor's dev sign-in.
      const agent = session ?? (api.dev ? DEV_SESSION : null);
      // A site that signs people in itself points agents at its own sign-in.
      if(!agent && await oauth.servesOAuth(api.state)) return oauth.unauthorized(api.state, url, request.headers.has("authorization"));
      if(!agent) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32001, message: "This site only lets agents in with a site session token (`Authorization: Bearer <token>`). For deployed sites, connect the agent to your agency panel's /mcp instead: it signs the agent in and covers every site in the panel." } },
          { status: 401, headers: { "www-authenticate": "Bearer" } }
        );
      }
      const scoped = new Engine(api.state, { origin: url.origin, session: agent, trusted: false, ctx: api.ctx });
      return await handleMcp(request, { engine: scoped });
    }
    const named = /^\/actions\/([\w.-]+)$/.exec(route);
    if(named) {
      if(method !== "POST") throw new HttpError(405, "Use POST");
      return await actionRoute(request, engine, url, named[1]!);
    }
    if(route === "/actions" && method === "GET") return json({ actions: describeActions(coreActions) });

    return await editorRoute(request, api, engine, route, method, url, session);
  } catch (error) {
    if(error instanceof HttpError) {
      return json(errorJson(fromHttpError(error)), { status: error.status });
    }
    console.error("vibe-cms:", error);
    return json({ error: "Internal error" }, { status: 500 });
  }
}

async function editorRoute(
  request: Request,
  api: ApiContext,
  engine: Engine,
  route: string,
  method: string,
  url: URL,
  session: Session | null
): Promise<Response> {
  const { config, db } = api.state;
  const q = url.searchParams;
  let m: RegExpExecArray | null;

  if(route === "/info" && method === "GET") {
    const site = await engine.site();
    const org = await api.state.org.status();
    return json({
      ...serializeConfig(config),
      prefix: api.state.prefix,
      dev: api.dev,
      hub: org.hub,
      signIn: await signInMode(api.state),
      site: descriptor(config, url, api.state.prefix, site, org),
      settings: site
    });
  }

  if(route === "/org/move") {
    if(method === "POST") {
      // Hub → site, server to server: a move to another org, signed by the current org's hub.
      const input = await body<{ token?: string }>(request);
      if(!input.token) throw new HttpError(400, "Expected token");
      return json(await api.state.org.requestMove(input.token, api.state.siteId));
    }
    if(method === "DELETE") {
      const user = require(config, session, { action: "write", scope: "site" });
      return json(await api.state.org.cancelMove(user.email ?? user.sub));
    }
  }

  if(route === "/org" && method === "GET") {
    require(config, session, { action: "write", scope: "site" });
    return json({ ...await api.state.org.status(), history: await api.state.org.history() });
  }

  if(route === "/session") {
    if(method === "GET") {
      if(!session) {
        // No credentials at all is a normal "not signed in", not an error; a bad token is.
        if(request.headers.has("authorization")) throw new HttpError(401, "Session expired");
        return json({ user: null });
      }
      return json({ user: session, permissions: permissionSummary(config, session) });
    }
    if(method === "POST") {
      const input = await body<{ code?: string, dev?: boolean, resume?: boolean }>(request);
      let next: Session;
      if(input.dev) {
        if(!api.dev) throw new HttpError(403, "Dev sessions are only available in development");
        next = DEV_SESSION;
      } else if(input.code) {
        next = await consumeCode(db, input.code);
      } else if(input.resume) {
        // The signed-in browser's cookie, for sites that sign people in themselves. Only from the site's own pages.
        const origin = request.headers.get("origin");
        if(origin && origin !== url.origin) throw new HttpError(403, "Cross-origin request refused");
        const resumed = await resume(api.state, readCookie(request, SIGNIN_COOKIE));
        if(!resumed) throw new HttpError(401, "Not signed in");
        next = resumed;
      } else {
        throw new HttpError(400, "Expected a code");
      }
      // Kept in the editor's memory: it only ever runs framed by the hub, or locally in development.
      const { token, expiresAt } = await issueSession(db, next, api.state.siteId, url.origin);
      return json({ token, expiresAt, user: next, permissions: permissionSummary(config, next) });
    }
    if(method === "DELETE") {
      return json({ ok: true }, { headers: { "set-cookie": await signOut(api.state, url, readCookie(request, SIGNIN_COOKIE)) } });
    }
  }

  if(route === "/auth" && method === "GET") {
    // How the editor offers sign-in.
    const mode = await signInMode(api.state);
    return json({
      mode,
      setup: await needsSetup(api.state),
      email: Boolean(api.state.signIn.email),
      provider: mode === "oidc" ? new URL(api.state.signIn.oidc!.issuer).host : null
    });
  }
  if(route === "/auth/passkey/register/options" && method === "POST") return json(await registrationOptions(api.state, url, await body(request)));
  if(route === "/auth/passkey/register" && method === "POST") {
    const { cookie } = await register(api.state, url, await body(request));
    return json({ ok: true }, { headers: { "set-cookie": cookie } });
  }
  if(route === "/auth/passkey/login/options" && method === "POST") return json(await authenticationOptions(api.state, url));
  if(route === "/auth/passkey/login" && method === "POST") {
    const { cookie } = await authenticate(api.state, url, await body(request));
    return json({ ok: true }, { headers: { "set-cookie": cookie } });
  }
  if(route === "/auth/oidc/login" && method === "GET") return oidcLogin(api.state, url);
  if(route === "/auth/oidc/callback" && method === "GET") return oidcCallback(api.state, url, readCookie(request, "vibe_login"));

  // Connecting an agent or the CLI: the editor shows the request, and posts the signed-in user's answer.
  if(route === "/oauth/request" && method === "GET") {
    if(!session) throw new HttpError(401, "Sign in required");
    return json(await oauth.describeRequest(api.state, q.get("id")));
  }
  if(route === "/oauth/decide" && method === "POST") {
    if(!session) throw new HttpError(401, "Sign in required");
    const identity = await cookieIdentity(api.state, readCookie(request, SIGNIN_COOKIE));
    return json(await oauth.decide(api.state, url, session, identity, await body(request)));
  }
  if(route === "/oauth/connections" && method === "GET") {
    if(!session) throw new HttpError(401, "Sign in required");
    return json({ connections: await oauth.listGrants(api.state, session.sub) });
  }
  if((m = /^\/oauth\/connections\/([\w-]+)$/.exec(route)) && method === "DELETE") {
    if(!session) throw new HttpError(401, "Sign in required");
    await oauth.disconnect(api.state, session.sub, m[1]!);
    return json({ ok: true });
  }

  if(route === "/users" && method === "GET") {
    require(config, session, { action: "read", scope: "users" });
    return json({ users: await listUsers(api.state), mode: await signInMode(api.state), roles: ["owner", ...Object.keys(config.permissions?.roles ?? {})] });
  }
  if(route === "/users/invites" && method === "POST") {
    const by = require(config, session, { action: "write", scope: "users" });
    return json(await invite(api.state, url.origin, by, await body(request)), { status: 201 });
  }
  if((m = /^\/users\/([\w-]+)$/.exec(route))) {
    if(method === "PATCH") {
      require(config, session, { action: "write", scope: "users" });
      return json(await updateUser(api.state, m[1]!, await body(request)));
    }
    if(method === "DELETE") {
      require(config, session, { action: "delete", scope: "users" });
      await removeUser(api.state, m[1]!);
      return json({ ok: true });
    }
  }

  if(route === "/session/code" && method === "POST") {
    // Hub → site, server to server: a token the hub signed for this site in, a one-time code out.
    const input = await body<{ token?: string }>(request);
    if(!input.token) throw new HttpError(400, "Expected token");
    const next = await sessionFromHubToken(api.state, input.token);
    if(!next || next.grants) throw new HttpError(401, "Not a sign-in token from this site's hub");
    return json({ code: await createCode(db, next), expiresIn: 30 });
  }

  if(route === "/preview" && method === "POST") {
    // A one-time code the preview window trades for its cookie at `GET {prefix}/preview`.
    if(!session) throw new HttpError(401, "Sign in required");
    return json({ code: await createCode(db, session), expiresIn: 30 });
  }
  if(route === "/preview" && method === "DELETE") {
    // The editor closed its preview: the cookie goes with it (from the editor's own cookie jar, or partition).
    return json({ ok: true }, { headers: { "set-cookie": previewCookie("", 0, url.protocol === "https:") } });
  }

  if((m = /^\/trash\/([\w-]+)\/file$/.exec(route)) && method === "GET") return engine.trashFile(m[1]!);

  for(const entry of restRoutes) {
    const params = matchRoute(entry.route, method, route);
    if(!params) continue;
    const action = coreActions[entry.action];
    const query: Record<string, string | string[]> = {};
    for(const key of new Set(q.keys())) {
      const values = q.getAll(key);
      query[key] = values.length > 1 ? values : values[0]!;
    }
    const input = { ...fromText(action.input, query), ...await restBody(request, entry, action.input), ...fromText(action.input, params) };
    const result = await runAction(action, { engine }, input);
    return result.isOk() ? json(result.value, { status: entry.status ?? 200 }) : errorResponse(result.error);
  }

  throw new HttpError(404, `No route for ${method} ${route}`);
}

interface RestRoute {
  /** `METHOD /path/:param`, relative to `/_vibe/api`. */
  route: string,
  action: keyof CoreActions,
  status?: number,
  /** How the body carries input: JSON (the default), multipart form fields, or raw text as one field. */
  body?: "form" | { text: string }
}

/**
 * The REST API: each route only says where an action's input comes from. Path params,
 * then the body, then the query string, in that order of precedence.
 */
const restRoutes: RestRoute[] = [
  { route: "GET /schema", action: "schema.list" },
  { route: "GET /schema/:type", action: "schema.get" },
  { route: "GET /site", action: "site.get" },
  { route: "PATCH /site", action: "site.update" },
  { route: "GET /documents/:type", action: "documents.list" },
  { route: "POST /documents/:type", action: "documents.create", status: 201 },
  { route: "GET /documents/:type/:id", action: "documents.get" },
  { route: "PUT /documents/:type/:id", action: "documents.update" },
  { route: "DELETE /documents/:type/:id", action: "documents.delete" },
  { route: "POST /documents/:type/:id/publish", action: "documents.publish" },
  { route: "POST /documents/:type/:id/unpublish", action: "documents.unpublish" },
  { route: "GET /documents/:type/:id/references", action: "documents.references" },
  { route: "GET /documents/:type/:id/versions", action: "documents.versions" },
  { route: "GET /documents/:type/:id/versions/:ver", action: "documents.version" },
  { route: "POST /documents/:type/:id/versions/:ver/restore", action: "documents.restoreVersion" },
  { route: "POST /documents/:type/:id/schedule", action: "documents.schedule" },
  { route: "DELETE /documents/:type/:id/schedule", action: "documents.unschedule" },
  { route: "GET /assets", action: "assets.list" },
  { route: "POST /assets", action: "assets.upload", status: 201, body: "form" },
  { route: "GET /assets/:id", action: "assets.get" },
  { route: "PATCH /assets/:id", action: "assets.update" },
  { route: "DELETE /assets/:id", action: "assets.delete" },
  { route: "PUT /assets/:id/content", action: "assets.replaceContent", body: { text: "content" } },
  { route: "GET /folders", action: "folders.list" },
  { route: "POST /folders", action: "folders.create", status: 201 },
  { route: "PATCH /folders", action: "folders.move" },
  { route: "DELETE /folders", action: "folders.delete" },
  { route: "GET /trash", action: "trash.list" },
  { route: "DELETE /trash", action: "trash.empty" },
  { route: "GET /trash/:id", action: "trash.get" },
  { route: "DELETE /trash/:id", action: "trash.purge" },
  { route: "POST /trash/:id/restore", action: "trash.restore" }
];

async function restBody(request: Request, entry: RestRoute, schema: AnyAction["input"]): Promise<Record<string, unknown>> {
  if(request.method === "GET" || request.method === "DELETE") return {};
  if(entry.body === "form") return fromText(schema, formValues(await request.formData()));
  if(entry.body) return { [entry.body.text]: await request.text() };
  return jsonBody(request);
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if(!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "Expected a JSON object body");
}

function formValues(form: FormData): Record<string, string | string[] | File> {
  const out: Record<string, string | string[] | File> = {};
  for(const key of new Set(form.keys())) {
    const values = form.getAll(key);
    out[key] = values.length > 1 ? values.filter(v => typeof v === "string") : values[0]!;
  }
  return out;
}

export function errorResponse(error: ActionError): Response {
  return json(errorJson(error), { status: httpStatus(error) });
}

/** Any action by name: `POST /_vibe/api/actions/documents.list` with its input as JSON or multipart. */
async function actionRoute(request: Request, engine: Engine, url: URL, name: string): Promise<Response> {
  const action = (coreActions as Record<string, AnyAction>)[name];
  if(!action) throw new HttpError(404, `No action "${name}"`);
  const type = request.headers.get("content-type") ?? "";
  const input = type.includes("multipart/form-data") ? fromText(action.input, formValues(await request.formData())) : filesFromJson(action, await jsonBody(request));
  const result = await runAction(action, { engine }, input);
  return result.isOk() ? json(result.value) : errorResponse(result.error);
}

async function pluginRoute(request: Request, api: ApiContext, name: string, path: string, session: Session | null) {
  const plugin = api.state.plugins.route(name);
  if(!plugin?.hooks.routes) return json({ error: `No plugin "${name}" routes` }, { status: 404 });
  for(const [pattern, handler] of Object.entries(plugin.hooks.routes)) {
    const params = matchRoute(pattern, request.method, path);
    if(params) return handler(request, { params, session });
  }
  return json({ error: "Not found" }, { status: 404 });
}

function redirect(url: URL, path: string, cookie: string): Response {
  return new Response(null, { status: 302, headers: { location: new URL(path, url.origin).href, "set-cookie": cookie, "cache-control": "no-store" } });
}

/**
 * `GET {prefix}/preview?code=…&path=/…`: trades the editor's code for a preview cookie, then opens the
 * page, or with `window=1` the pop-out's window page around it.
 */
async function startPreview(api: ApiContext, url: URL): Promise<Response> {
  const { db } = api.state;
  const code = url.searchParams.get("code");
  if(!code) throw new HttpError(400, "Expected a code");
  const session = await consumeCode(db, code);
  const { token, expiresAt } = await issueSession(db, session, api.state.siteId, url.origin);
  const cookie = previewCookie(token, Math.min(PREVIEW_TTL, expiresAt - Math.floor(Date.now() / 1000)), url.protocol === "https:");
  const path = safePath(url.searchParams.get("path"));
  return redirect(url, url.searchParams.get("window") === "1" ? `${api.state.prefix}/preview/window?path=${encodeURIComponent(path)}` : path, cookie);
}

/** The editor is static assets; deep links fall back to its index.html. */
async function serveAdmin(request: Request, api: ApiContext, url: URL): Promise<Response> {
  const index = `${api.state.prefix}/admin/`;
  if(url.pathname === `${api.state.prefix}/admin`) return Response.redirect(`${url.origin}${index}${url.search}${url.hash}`, 302);
  if(!api.assets) {
    return new Response(
      "vibe-cms: the editor is served from static assets. Build with the vibe() Vite plugin, "
      + "and pass `assets: env.ASSETS` in createHandler bindings if your assets binding isn't named ASSETS.",
      { status: 404 }
    );
  }
  const response = await api.assets.fetch(new Request(new URL(index, url.origin), { headers: request.headers }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache");
  return new Response(response.body, { status: response.ok ? 200 : response.status, headers });
}
