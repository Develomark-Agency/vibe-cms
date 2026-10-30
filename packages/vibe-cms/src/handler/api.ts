import { HttpError, serializeConfig, type AnyConfig } from "../config.ts";
import type { Order, SerializedQuery } from "../query/index.ts";
import type { Session } from "../server/index.ts";
import { consumeCode, createCode, DEV_SESSION, issueSession, permissionSummary, sessionFromIdToken, verifySession } from "./auth.ts";
import { Engine, type EngineState, type SiteSettings, type SiteSettingsPatch } from "./engine.ts";
import type { ExecutionContext, Fetcher } from "./platform.ts";
import { matchRoute } from "./plugins.ts";

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

function siteId(config: AnyConfig, url: URL): string {
  return config.id ?? url.hostname;
}

function readCookie(request: Request, name: string): string | undefined {
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

    return await editorRoute(request, api, engine, route, method, url, session);
  } catch (error) {
    if(error instanceof HttpError) {
      return json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
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

  if(route === "/site") {
    if(method === "GET") return json(await engine.site(url.hostname));
    if(method === "PATCH") return json(await engine.updateSite(await body<SiteSettingsPatch>(request), url.hostname));
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

  if((m = /^\/documents\/([\w-]+)$/.exec(route))) {
    const type = m[1]!;
    if(method === "GET") {
      const sort = q.get("sort");
      const orderBy: Order[] | undefined = sort
        ? [{ path: [sort.replace(/^-/, "")], dir: sort.startsWith("-") ? "desc" : "asc" }]
        : undefined;
      return json(await engine.listDocuments(type, {
        locale: q.get("locale") ?? undefined,
        search: q.get("search") ?? undefined,
        limit: Number(q.get("limit") ?? 50),
        offset: Number(q.get("offset") ?? 0),
        orderBy
      }));
    }
    if(method === "POST") {
      const input = await body<{ id?: string, locale?: string, data: unknown, publish?: boolean }>(request);
      return json(await engine.save({ type, id: input.id, locale: input.locale, data: input.data, publish: input.publish }), { status: 201 });
    }
  }

  if((m = /^\/documents\/([\w-]+)\/([\w-]+)(\/.*)?$/.exec(route))) {
    const [, type, id, rest = ""] = m as unknown as [string, string, string, string?];
    const locale = q.get("locale") ?? undefined;
    if(rest === "") {
      if(method === "GET") return json(await engine.getDocument(type, id, locale));
      if(method === "PUT") {
        const input = await body<{ locale?: string, data: unknown, baseUpdatedAt?: number, publish?: boolean }>(request);
        return json(await engine.save({ type, id, locale: input.locale ?? locale, data: input.data, baseUpdatedAt: input.baseUpdatedAt, publish: input.publish }));
      }
      if(method === "DELETE") return json(await engine.delete(type, id, { force: q.get("force") === "1", locale }));
    }
    if(rest === "/publish" && method === "POST") return json(await engine.publish(type, id, (await body<{ locale?: string }>(request)).locale ?? locale));
    if(rest === "/unpublish" && method === "POST") return json(await engine.unpublish(type, id, (await body<{ locale?: string }>(request)).locale ?? locale));
    if(rest === "/references" && method === "GET") return json({ references: await engine.incomingReferences(id) });
    if(rest === "/versions" && method === "GET") return json({ versions: await engine.versions(type, id, locale) });
    const ver = /^\/versions\/(\d+)(\/restore)?$/.exec(rest);
    if(ver && !ver[2] && method === "GET") return json(await engine.version(type, id, locale, Number(ver[1])));
    if(ver && ver[2] && method === "POST") return json(await engine.restore(type, id, (await body<{ locale?: string }>(request)).locale ?? locale, Number(ver[1])));
    if(rest === "/schedule") {
      if(method === "POST") {
        const input = await body<{ locale?: string, action: "publish" | "unpublish", runAt: string }>(request);
        if(input.action !== "publish" && input.action !== "unpublish") throw new HttpError(400, "action must be publish or unpublish");
        return json(await engine.schedule(type, id, input.locale ?? locale, input.action, input.runAt));
      }
      if(method === "DELETE") {
        const action = q.get("action") === "unpublish" ? "unpublish" : "publish";
        return json(await engine.cancelSchedule(type, id, locale, action));
      }
    }
  }

  if(route === "/assets") {
    if(method === "GET") {
      return json(await engine.listAssets({
        folder: q.has("folder") ? q.get("folder")! : undefined,
        search: q.get("search") ?? undefined,
        accept: q.getAll("accept"),
        limit: Number(q.get("limit") ?? 60),
        offset: Number(q.get("offset") ?? 0)
      }));
    }
    if(method === "POST") {
      const form = await request.formData();
      const file = form.get("file");
      if(!file || typeof file === "string") throw new HttpError(400, "Expected a file");
      return json(await engine.upload(file as File, {
        folder: (form.get("folder") as string | null) || undefined,
        type: (form.get("type") as string | null) || undefined,
        field: (form.get("field") as string | null) || undefined
      }), { status: 201 });
    }
  }

  if(route === "/folders") {
    if(method === "GET") return json({ folders: await engine.listFolders() });
    if(method === "POST") return json(await engine.createFolder((await body<{ path: string }>(request)).path ?? ""), { status: 201 });
    if(method === "PATCH") {
      const input = await body<{ from: string, to: string }>(request);
      return json(await engine.moveFolder(input.from ?? "", input.to ?? ""));
    }
    if(method === "DELETE") return json(await engine.deleteFolder(q.get("path") ?? ""));
  }

  if((m = /^\/assets\/([\w-]+)\/content$/.exec(route)) && method === "PUT") {
    return json(await engine.replaceContent(m[1]!, await request.arrayBuffer()));
  }

  if((m = /^\/assets\/([\w-]+)$/.exec(route))) {
    if(method === "GET") return json(await engine.getAsset(m[1]!));
    if(method === "PATCH") return json(await engine.updateAsset(m[1]!, await body(request)));
    if(method === "DELETE") return json(await engine.deleteAsset(m[1]!));
  }

  throw new HttpError(404, `No route for ${method} ${route}`);
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
