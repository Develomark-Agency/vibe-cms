import { HttpError, serializeConfig, type AnyConfig } from "../config.ts";
import type { SerializedQuery } from "../query/index.ts";
import type { Session } from "../server/index.ts";
import { consumeCode, createCode, DEV_SESSION, issueSession, permissionSummary, sessionFromIdToken, verifySession } from "./auth.ts";
import { coreActions, type CoreActions } from "../actions/core.ts";
import { runAction, type AnyAction } from "../actions/define.ts";
import { errorJson, fromHttpError, httpStatus, type ActionError } from "../actions/errors.ts";
import { describeActions, filesFromJson } from "../actions/describe.ts";
import { fromText } from "../actions/inputs.ts";
import { Engine, type EngineState, type SiteSettings } from "./engine.ts";
import { handleMcp } from "./mcp.ts";
import type { ExecutionContext, Fetcher } from "./platform.ts";
import { matchRoute } from "./plugins.ts";
import { previewCookie, previewScriptResponse, safePath } from "./preview.ts";

export interface ApiContext {
  state: EngineState,
  dev: boolean,
  assets: Fetcher | undefined,
  ctx: ExecutionContext
}

const COOKIE = "vibe_session";

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function siteId(config: AnyConfig, url: URL): string {
  return config.id ?? url.hostname;
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for(const part of header.split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if(key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

async function readSession(request: Request, api: ApiContext, url: URL): Promise<Session | null> {
  const header = request.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : readCookie(request, COOKIE);
  if(!token) return null;
  return verifySession(api.state.db, token, siteId(api.state.config, url));
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

export function descriptor(config: AnyConfig, url: URL, prefix: string, site: SiteSettings) {
  return {
    protocol: 1,
    id: siteId(config, url),
    name: site.name,
    accent: site.accent,
    icon: site.icon?.url ?? null,
    auth: config.auth ? { issuer: config.auth.issuer, clientId: config.auth.clientId } : null,
    admin: `${url.origin}${prefix}/admin`
  };
}

/** Handles everything under the prefix. Returns null for paths the CMS doesn't own. */
export async function handleRequest(request: Request, api: ApiContext): Promise<Response> {
  const url = new URL(request.url);
  const { config, prefix } = api.state;
  if(url.pathname === "/.well-known/vibe-cms") {
    const site = await new Engine(api.state, { origin: url.origin, session: null, trusted: false }).site(url.hostname);
    return cors(json(descriptor(config, url, prefix, site), { headers: { "cache-control": "public, max-age=60" } }));
  }
  const path = url.pathname.slice(prefix.length) || "/";
  const method = request.method.toUpperCase();
  try {
    if(path === "/admin" || path.startsWith("/admin/")) return await serveAdmin(request, api, url);
    if(path === "/preview.js" && method === "GET") return previewScriptResponse(prefix);
    if(path === "/preview" && method === "GET") return await startPreview(api, url);
    if(path === "/preview/exit" && method === "GET") {
      return redirect(url, safePath(url.searchParams.get("path")), previewCookie("", 0, url.protocol === "https:"));
    }
    const session = await readSession(request, api, url);
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
      // Development sites let local agents in as the developer, like the editor's dev sign-in.
      const agent = session ?? (api.dev ? DEV_SESSION : null);
      if(!agent) {
        return json(
          { jsonrpc: "2.0", id: null, error: { code: -32001, message: "This site only lets agents in with a site session token (`Authorization: Bearer <token>`). For deployed sites, connect the agent to your agency panel's /mcp instead: it signs the agent in and covers every site in the panel." } },
          { status: 401, headers: { "www-authenticate": "Bearer" } }
        );
      }
      const scoped = new Engine(api.state, { origin: url.origin, session: agent, trusted: false, ctx: api.ctx });
      return await handleMcp(request, { engine: scoped, host: url.hostname });
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
    const site = await engine.site(url.hostname);
    return json({
      ...serializeConfig(config),
      prefix: api.state.prefix,
      dev: api.dev,
      auth: config.auth ? { issuer: config.auth.issuer } : null,
      site: descriptor(config, url, api.state.prefix, site),
      settings: site
    });
  }

  if(route === "/session") {
    if(method === "GET") {
      if(!session) {
        // No credentials at all is a normal "not signed in", not an error; a bad token is.
        const sent = request.headers.has("authorization") || readCookie(request, COOKIE) !== undefined;
        if(sent) throw new HttpError(401, "Session expired");
        return json({ user: null });
      }
      return json({ user: session, permissions: permissionSummary(config, session) });
    }
    if(method === "POST") {
      const input = await body<{ code?: string, dev?: boolean, cookie?: boolean }>(request);
      let next: Session;
      if(input.dev) {
        if(!api.dev) throw new HttpError(403, "Dev sessions are only available in development");
        next = DEV_SESSION;
      } else if(input.code) {
        next = await consumeCode(db, input.code);
      } else {
        throw new HttpError(400, "Expected a code");
      }
      const { token, expiresAt } = await issueSession(db, next, siteId(config, url), url.origin);
      const headers = new Headers();
      if(input.cookie) {
        const secure = url.protocol === "https:" ? "; Secure" : "";
        headers.append(
          "set-cookie",
          `${COOKIE}=${token}; Path=${api.state.prefix}; HttpOnly; SameSite=Strict; Max-Age=${expiresAt - Math.floor(Date.now() / 1000)}${secure}`
        );
      }
      return json({ token: input.cookie ? undefined : token, expiresAt, user: next, permissions: permissionSummary(config, next) }, { headers });
    }
    if(method === "DELETE") {
      return json({ ok: true }, { headers: { "set-cookie": `${COOKIE}=; Path=${api.state.prefix}; HttpOnly; SameSite=Strict; Max-Age=0` } });
    }
  }

  if(route === "/session/code" && method === "POST") {
    // Panel backend → site, server to server.
    const input = await body<{ id_token?: string }>(request);
    if(!input.id_token) throw new HttpError(400, "Expected id_token");
    const next = await sessionFromIdToken(config, input.id_token);
    return json({ code: await createCode(db, next), expiresIn: 30 });
  }

  if(route === "/preview" && method === "POST") {
    // A one-time code the preview window trades for its cookie at `GET {prefix}/preview`.
    if(!session) throw new HttpError(401, "Sign in required");
    return json({ code: await createCode(db, session), expiresIn: 30 });
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
    const result = await runAction(action, { engine, host: url.hostname }, input);
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
  const result = await runAction(action, { engine, host: url.hostname }, input);
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

/** `GET {prefix}/preview?code=…&path=/…`: trades the editor's code for a preview cookie, then opens the page. */
async function startPreview(api: ApiContext, url: URL): Promise<Response> {
  const { config, db } = api.state;
  const code = url.searchParams.get("code");
  if(!code) throw new HttpError(400, "Expected a code");
  const session = await consumeCode(db, code);
  const { token, expiresAt } = await issueSession(db, session, siteId(config, url), url.origin);
  const cookie = previewCookie(token, expiresAt - Math.floor(Date.now() / 1000), url.protocol === "https:");
  return redirect(url, safePath(url.searchParams.get("path")), cookie);
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
