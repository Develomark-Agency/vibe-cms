import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { HttpError } from "../config.ts";
import { fromHttpError } from "../actions/define.ts";
import { errorBody, isActionError } from "../actions/errors.ts";
import { announceSetup } from "./signin.ts";
import { Engine } from "./engine.ts";
import { errorResponse, json, readSession, type SiteEnv } from "./http.ts";
import { actions } from "./routes/actions.ts";
import { admin } from "./routes/admin.ts";
import { auth } from "./routes/auth.ts";
import { backupTransfers } from "./routes/backups.ts";
import { content, query } from "./routes/content.ts";
import { mcp } from "./routes/mcp.ts";
import { connections, oauthServer } from "./routes/oauth.ts";
import { org } from "./routes/org.ts";
import { plugins } from "./routes/plugins.ts";
import { previewApi, previewPages } from "./routes/preview.ts";
import { discovery, info } from "./routes/site.ts";
import { users } from "./routes/users.ts";
import { roles } from "./routes/roles.ts";

/**
 * The JSON API under `{prefix}/api`, as one chain so `hc<SiteApi>` (the editor's client) can read its types.
 * It doesn't depend on the prefix. The REST table, plugin routes and signed backup links aren't part of
 * the typed API: they're registered dynamically, or called by something other than the editor.
 */
export const apiRoutes = new Hono<SiteEnv>()
  // Responses are private and never cached unless a route says otherwise.
  .use(async (c, next) => {
    await next();
    if(!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  })
  .route("/", query)
  .route("/", mcp)
  .route("/", actions)
  .route("/", info)
  .route("/", org)
  .route("/", auth)
  .route("/", connections)
  .route("/", users)
  .route("/", roles)
  .route("/", previewApi);

apiRoutes.all("*", c => {
  throw new HttpError(404, `No route for ${c.req.method} ${new URL(c.req.url).pathname.slice(`${c.env.state.prefix}/api`.length)}`);
});

export type SiteApi = typeof apiRoutes;

/**
 * The CMS's HTTP routes, for a site whose editor lives under `prefix`. Call `router.fetch(request, api)`:
 * the `ApiContext` is the router's `env`.
 *
 * - Public routes first: discovery and the OAuth server (some at the site's root), the editor's static
 *   files, preview pages and signed backup links.
 * - Then every request gets its `session` and `engine`, and the rest follow: media, plugin routes, and
 *   the JSON API under `{prefix}/api`.
 */
export function createRouter(prefix: string) {
  const root = new Hono<SiteEnv>();

  root.onError(error => {
    // A body the router's validators couldn't read.
    if(error instanceof HTTPException) return json({ error: error.message }, { status: error.status });
    if(error instanceof HttpError) return json(errorBody(fromHttpError(error)), { status: error.status });
    // An action that failed on its own terms.
    if(isActionError(error)) return errorResponse(error);
    console.error("vibe-cms:", error);
    return json({ error: "Internal error" }, { status: 500 });
  });

  root.route("/", discovery);
  root.route("/", oauthServer(prefix));

  const site = new Hono<SiteEnv>();
  site.route("/", admin);
  site.route("/", previewPages(prefix));
  site.route("/", backupTransfers);

  site.use("*", async (c, next) => {
    const { state, dev, ctx } = c.env;
    const url = new URL(c.req.url);
    // A site nobody owns yet prints its one-time setup link to its logs.
    if(!dev) ctx.waitUntil?.(announceSetup(state, url.origin).catch(() => {}));
    const session = await readSession(c.req.raw, c.env);
    c.set("session", session);
    c.set("engine", new Engine(state, { origin: url.origin, session, trusted: false, ctx }));
    await next();
  });

  site.route("/", content);
  site.route("/", plugins);

  site.route("/api", apiRoutes);
  site.all("*", () => json({ error: "Not found" }, { status: 404 }));

  root.route(prefix, site);
  return root;
}

export type Router = ReturnType<typeof createRouter>;
