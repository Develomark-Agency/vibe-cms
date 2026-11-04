import { Hono } from "hono";
import type { ServerHooks, Session } from "../../server/index.ts";
import { json, type SiteContext, type SiteEnv } from "../http.ts";

type PluginRoutes = NonNullable<ServerHooks["routes"]>;
/** The plugin's router is handed who is asking as its `env`. */
type PluginEnv = { Bindings: { session: Session | null } };

/** A plugin's routes (`"METHOD /path/:param"` → handler) as a router of their own, built once per plugin. */
const compiled = new WeakMap<PluginRoutes, Hono<PluginEnv>>();

function pluginRouter(routes: PluginRoutes) {
  let app = compiled.get(routes);
  if(app) return app;
  app = new Hono<PluginEnv>();
  for(const [pattern, handler] of Object.entries(routes)) {
    const [method, rawPath] = pattern.includes(" ") ? pattern.split(/\s+/, 2) as [string, string] : ["*", pattern];
    const path = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    // A final `*` hands the handler the rest of the path as `params["*"]`.
    const wildcard = path.endsWith("/*") ? path.split("/").filter(Boolean).length - 1 : -1;
    app.on(method === "*" ? "ALL" : method.toUpperCase(), path, c => {
      const params: Record<string, string> = { ...c.req.param() };
      if(wildcard >= 0) params["*"] = new URL(c.req.url).pathname.split("/").filter(Boolean).slice(wildcard).join("/");
      return handler(c.req.raw, { params, session: c.env.session });
    });
  }
  app.notFound(() => json({ error: "Not found" }, { status: 404 }));
  // A handler that throws is the site's error to log and answer, not this router's.
  app.onError(error => {
    throw error;
  });
  compiled.set(routes, app);
  return app;
}

/** `{prefix}/plugins/<name>/…`: each plugin's own routes. Public unless the plugin checks the session. */
export const plugins = new Hono<SiteEnv>();

async function serve(c: SiteContext) {
  const { state } = c.env;
  const name = c.req.param("name")!;
  const plugin = state.plugins.route(name);
  if(!plugin?.hooks.routes) return json({ error: `No plugin "${name}" routes` }, { status: 404 });
  const url = new URL(c.req.url);
  const base = `${state.prefix}/plugins/${name}`;
  const rest = url.pathname.slice(base.length) || "/";
  const request = new Request(new URL(rest + url.search, url.origin), c.req.raw);
  return pluginRouter(plugin.hooks.routes).fetch(request, { session: c.get("session") });
}

plugins.all("/plugins/:name", serve);
plugins.all("/plugins/:name/*", serve);
