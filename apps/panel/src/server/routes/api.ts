import { Hono } from "hono";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { fetchDescriptor, normalizeBranding, PanelError, type PanelSite } from "vibe-cms/panel";
import { hubRecordName, resolveHub } from "vibe-cms/org";
import * as t from "../schema.ts";
import { codeFor, hubOrg, hubOrigin, moveSites, rememberOrigin, syncOrg } from "../hub.ts";
import { listAgents, oauth, resourceUrl, revokeGrant } from "../oauth.ts";
import { currentSession, db, siteById } from "../shared.ts";
import type { AppEnv } from "../context.ts";
import { backups } from "./backups.ts";
import { siteBody } from "./validate.ts";
import { access } from "./access.ts";
import { announceSetup, applyTemplate, defaultTemplateId, grantAdder, hasOwner, hubAccess, requirePermission, requireVisibleSite, visibleSiteIds } from "../access.ts";

/**
 * The panel's JSON API, mounted at `/api`: sites, the org, connected agents, backups. One chain, so
 * `hc<PanelApi>` (see `web/backend.ts`) gets every route's path, input and response type.
 */
export const api = new Hono<AppEnv>()
  .use(async (c, next) => {
    await rememberOrigin(c.env, new URL(c.req.url).origin);
    await next();
  })

  // Responses are private and never cached unless a route says otherwise.
  .use(async (c, next) => {
    await next();
    if(!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  })

  // Public: the sign-in page needs the panel's name before anyone is signed in.
  .get("/branding", c => {
    const { PANEL_NAME, PANEL_ACCENT, PANEL_ICON } = c.env;
    return c.json(normalizeBranding({ name: PANEL_NAME, accent: PANEL_ACCENT, icon: PANEL_ICON }), 200, { "cache-control": "public, max-age=300" });
  })

  // Public: whether the panel still needs its first owner, for the setup page.
  .get("/setup", async c => {
    const owned = await hasOwner(c.env);
    if(!owned) await announceSetup(c.env, new URL(c.req.url).origin);
    return c.json({ needsOwner: !owned });
  })

  // Everything below is for signed-in editors.
  .use(async (c, next) => {
    const session = await currentSession(c.req.raw, c.env);
    if(!session) return c.json({ error: "Not signed in" }, 401);
    c.set("session", session);
    // Browsers only reach the API from the panel's own pages.
    const origin = c.req.header("origin");
    if(c.req.method !== "GET" && origin && origin !== new URL(c.req.url).origin) return c.json({ error: "Cross-origin request refused" }, 403);
    await next();
  })

  .get("/me", async c => {
    const session = c.get("session");
    const me = await hubAccess(c.env, session);
    return c.json({ name: session.name ?? undefined, email: session.email ?? undefined, role: me.role, permissions: me.permissions, admin: me.admin });
  })

  .route("/", access)

  .route("/", backups)

  .get("/sites", async c => {
    const visible = await visibleSiteIds(c.env, await hubAccess(c.env, c.get("session")));
    const results = await db(c.env)
      .select({ id: t.sites.id, url: t.sites.url, name: t.sites.name, admin: t.sites.admin, favorite: isNotNull(t.favorites.user) })
      .from(t.sites)
      .leftJoin(t.favorites, and(eq(t.favorites.site_id, t.sites.id), eq(t.favorites.user, c.get("session").sub)))
      .orderBy(t.sites.name);
    return c.json(results.filter(r => visible === "all" || visible.has(r.id)).map(r => ({ ...r, favorite: Boolean(r.favorite) })));
  })

  .post("/sites", siteBody, async c => {
    const env = c.env;
    const me = await hubAccess(env, c.get("session"));
    requirePermission(me, "addSites");
    const input = c.req.valid("json");
    const descriptor = await fetchDescriptor(input.url);
    // The site has to have agreed to trust this hub's org.
    const org = hubOrg(env);
    if(descriptor.org !== org) {
      throw new PanelError(422, descriptor.org ? `This site trusts another org (${descriptor.org}), not ${org}` : `This site doesn't belong to an org yet. Set VIBE_ORG=${org} in its environment and deploy it.`);
    }
    const site: PanelSite = { id: descriptor.id, url: new URL(descriptor.admin).origin, name: descriptor.name, admin: descriptor.admin, favorite: false };
    const [existing] = await db(env).select({ id: t.sites.id }).from(t.sites).where(eq(t.sites.id, site.id));
    await db(env).insert(t.sites)
      .values({ id: site.id, url: site.url, name: site.name, admin: site.admin, org: descriptor.org, added_by: me.sub, added_at: Date.now() })
      .onConflictDoUpdate({ target: t.sites.id, set: { url: site.url, name: site.name, admin: site.admin, org: descriptor.org } });
    if(existing) return c.json({ ...site, template: null }, 201);
    // Whoever adds a site manages it; then its starting roles, copied from a template.
    await grantAdder(env, site.id, me.sub);
    const templateId = input.templateId === undefined ? await defaultTemplateId(env) : input.templateId;
    const template = templateId ? await applyTemplate(env, site, templateId, me.sub) : null;
    return c.json({ ...site, template }, 201);
  })

  .delete("/sites/:id", async c => {
    const id = c.req.param("id");
    const me = await hubAccess(c.env, c.get("session"));
    const [row] = await db(c.env).select({ addedBy: t.sites.added_by }).from(t.sites).where(eq(t.sites.id, id));
    if(!row) return c.body(null, 204);
    if(!me.permissions.includes("removeSites") && row.addedBy !== me.sub) throw new PanelError(403, "You can't remove this site");
    await db(c.env).batch([
      db(c.env).delete(t.favorites).where(eq(t.favorites.site_id, id)),
      db(c.env).delete(t.sites).where(eq(t.sites.id, id))
    ]);
    return c.body(null, 204);
  })

  .put("/sites/:id/favorite", async c => {
    await requireVisibleSite(c.env, await hubAccess(c.env, c.get("session")), c.req.param("id"));
    await db(c.env).insert(t.favorites).values({ user: c.get("session").sub, site_id: c.req.param("id") }).onConflictDoNothing();
    return c.body(null, 204);
  })

  .delete("/sites/:id/favorite", async c => {
    await db(c.env).delete(t.favorites).where(and(eq(t.favorites.user, c.get("session").sub), eq(t.favorites.site_id, c.req.param("id"))));
    return c.body(null, 204);
  })

  .post("/sites/:id/code", async c => {
    const site = await siteById(c.env, c.req.param("id"));
    if(!site) throw new PanelError(404, "Unknown site");
    await requireVisibleSite(c.env, await hubAccess(c.env, c.get("session")), site.id);
    return c.json({ code: await codeFor(c.env, c.get("session"), site) });
  })

  .get("/org", async c => {
    const env = c.env;
    const { org, previous } = await syncOrg(env);
    const hub = await resolveHub(org, { fresh: true }).catch((error: Error) => ({ error: error.message }));
    const results = await db(env).select({ org: t.sites.org, sites: count() }).from(t.sites).groupBy(t.sites.org);
    return c.json({
      org,
      previous,
      // Where the org's DNS record points, and whether that's here.
      record: hubRecordName(org),
      hub: typeof hub === "string" ? hub : null,
      hubError: typeof hub === "string" ? null : hub.error,
      matches: typeof hub === "string" && hub === (await hubOrigin(env) ?? new URL(c.req.url).origin),
      sites: results
    });
  })

  // Asks sites still on a previous org to move now, rather than at the next cron run.
  .post("/org/moves", async c => {
    if(!(await hubAccess(c.env, c.get("session"))).admin) throw new PanelError(403, "Only the panel's owner and admins can move sites");
    return c.json(await moveSites(c.env));
  })

  .get("/agents", async c => c.json({ mcpUrl: resourceUrl(new URL(c.req.url)), agents: await listAgents(c.env, c.get("session").sub) }))

  .delete("/agents/:id", async c => {
    const grant = await oauth(c.env).userGrant(c.get("session").sub, c.req.param("id"));
    if(!grant) throw new PanelError(404, "Unknown agent");
    await revokeGrant(c.env, grant);
    return c.body(null, 204);
  });

// Not part of the typed API: anything else under /api.
api.all("*", c => c.json({ error: "Not found" }, 404));
