import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { PanelError } from "vibe-cms/panel";
import { handleMcp, siteToken } from "../mcp.ts";
import { canSeeSite, hubAccess, visibleSiteIds } from "../access.ts";
import { attachSite } from "../sites.ts";
import {
  authorize,
  codePage,
  corsPreflight,
  decide,
  grantForRequest,
  oauth,
  protectedResourceMetadata,
  SCOPE_READ,
  type GrantRow
} from "../oauth.ts";
import { jwks } from "../hub.ts";
import * as t from "../schema.ts";
import { db, siteById, type Env } from "../shared.ts";
import { siteOrigin } from "vibe-cms/panel";
import pkg from "../../../package.json" with { type: "json" };
import type { AppEnv } from "../context.ts";

/**
 * How agents and the CLI reach the panel: the panel as an OAuth server, the keys sites verify its
 * tokens with, `/site-token`, and the MCP endpoint.
 */
export const agents = new Hono<AppEnv>();

// Browsers reach these from other origins (an agent's web client), so they answer preflights.
for(const path of ["/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke", "/site-token", "/site-list", "/site-attach", "/.well-known/*"]) {
  agents.options(path, () => corsPreflight());
}

agents.get("/.well-known/oauth-protected-resource", c => protectedResourceMetadata(c.env, new URL(c.req.url)));
agents.get("/.well-known/oauth-protected-resource/mcp", c => protectedResourceMetadata(c.env, new URL(c.req.url)));
agents.get("/.well-known/oauth-authorization-server", c => oauth(c.env).authorizationServerMetadata(new URL(c.req.url)));
// The keys sites verify the hub's tokens with.
agents.get("/.well-known/jwks.json", c => jwks(c.env));

agents.post("/oauth/register", c => oauth(c.env).register(c.req.raw));
agents.get("/oauth/authorize", c => authorize(c.req.raw, c.env, new URL(c.req.url)));
agents.post("/oauth/authorize", c => decide(c.req.raw, c.env, new URL(c.req.url)));
agents.post("/oauth/token", c => oauth(c.env).token(c.req.raw));
agents.post("/oauth/revoke", c => oauth(c.env).revoke(c.req.raw));
// Where `vibe-cms login --headless` lands: the code to paste into the terminal.
agents.get("/oauth/code", c => codePage(new URL(c.req.url)));

/**
 * `POST /site-token` with an OAuth access token: a session on one site for the connection's user,
 * for clients that call sites directly, like the CLI. `site` is the site's id or URL.
 */
agents.post("/site-token", async c => {
  const grant = await grantForRequest(c.req.raw, c.env);
  if(!grant) return c.json({ error: "Log in again: this access token is unknown or expired" }, 401, { "www-authenticate": "Bearer" });
  return siteTokenRoute(c.req.raw, c.env, grant);
});

/**
 * `POST /site-list` with an OAuth access token: the sites the connection's user can see, for clients
 * that offer a choice of them, like the CLI. Read-only connections may list.
 */
agents.post("/site-list", async c => {
  const grant = await grantForRequest(c.req.raw, c.env);
  if(!grant) return c.json({ error: "Log in again: this access token is unknown or expired" }, 401, { "www-authenticate": "Bearer" });
  const [session] = await db(c.env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
  if(!session) throw new PanelError(401, "This connection's sign-in is gone. Log in again.");
  const visible = await visibleSiteIds(c.env, await hubAccess(c.env, session));
  const rows = await db(c.env).select({ id: t.sites.id, url: t.sites.url, name: t.sites.name, admin: t.sites.admin }).from(t.sites).orderBy(t.sites.name);
  return c.json({ sites: rows.filter(row => visible === "all" || visible.has(row.id)) }, 200, { "cache-control": "no-store" });
});

/**
 * `POST /site-attach` with an OAuth access token: attaches a site from its claim link, for the CLI and
 * other clients, as the connection's user. Body: `{ link, templateId? }`; the reply is the added site.
 */
agents.post("/site-attach", async c => {
  const grant = await grantForRequest(c.req.raw, c.env);
  if(!grant) return c.json({ error: "Log in again: this access token is unknown or expired" }, 401, { "www-authenticate": "Bearer" });
  if(grant.scope === SCOPE_READ) throw new PanelError(403, "This connection is read-only, and attaching a site changes things");
  const input = await c.req.json().catch(() => null) as { link?: unknown, templateId?: unknown } | null;
  if(typeof input?.link !== "string") throw new PanelError(400, "Expected link");
  if(input.templateId !== undefined && input.templateId !== null && typeof input.templateId !== "string") throw new PanelError(400, "Expected templateId");
  const [session] = await db(c.env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
  if(!session) throw new PanelError(401, "This connection's sign-in is gone. Log in again.");
  const site = await attachSite(c.env, await hubAccess(c.env, session), { link: input.link, templateId: input.templateId });
  return c.json(site, 201, { "cache-control": "no-store" });
});

agents.all("/mcp", async c => {
  const grant = await grantForRequest(c.req.raw, c.env);
  if(!grant) return oauth(c.env).unauthorized(new URL(c.req.url), c.req.raw.headers.has("authorization"));
  return handleMcp(c.req.raw, c.env, grant, pkg.version);
});

async function siteTokenRoute(request: Request, env: Env, grant: GrantRow): Promise<Response> {
  // A site session can do whatever the user may; a read-only connection can't be held to less.
  if(grant.scope === SCOPE_READ) throw new PanelError(403, "This connection is read-only, and site tokens aren't");
  const { site: target } = await request.json().catch(() => ({})) as { site?: string };
  if(!target) throw new PanelError(400, "Expected site");
  let site = await siteById(env, target);
  if(!site && URL.canParse(target)) {
    const [row] = await db(env).select({ id: t.sites.id, url: t.sites.url, name: t.sites.name, admin: t.sites.admin }).from(t.sites).where(eq(t.sites.url, siteOrigin(target)));
    site = row ? { ...row, favorite: false } : null;
  }
  if(!site) throw new PanelError(404, `${target} isn't in this panel. Add it in the panel first.`);
  const [session] = await db(env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
  if(!session) throw new PanelError(401, "This connection's sign-in is gone. Log in again.");
  if(!await canSeeSite(env, await hubAccess(env, session), site.id)) throw new PanelError(404, `${target} isn't in this panel. Add it in the panel first.`);
  return Response.json({ token: await siteToken(env, grant, session, site), site: { id: site.id, name: site.name, admin: site.admin } }, { headers: { "cache-control": "no-store" } });
}
