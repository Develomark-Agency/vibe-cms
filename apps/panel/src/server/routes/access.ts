import { Hono } from "hono";
import { validator } from "hono/validator";
import { PanelError } from "vibe-cms/panel";
import {
  applyTemplate,
  assign,
  deleteHubRole,
  deleteTemplate,
  grantSite,
  hubAccess,
  HUB_PERMISSIONS,
  inviteMember,
  listHubRoles,
  listMembers,
  listTemplates,
  removeMember,
  requireSiteManager,
  requireVisibleSite,
  revokeSite,
  saveHubRole,
  saveTemplate,
  siteAccess,
  siteRoles,
  unassign,
  updateMember
} from "../access.ts";
import { siteById } from "../shared.ts";
import type { AppContext, AppEnv } from "../context.ts";

/** A JSON object body; the access functions check each field. */
const body = validator("json", value => {
  if(typeof value !== "object" || value === null || Array.isArray(value)) throw new PanelError(400, "Expected a JSON object body");
  return value as Record<string, unknown>;
});

async function siteFor(c: AppContext) {
  const site = await siteById(c.env, c.req.param("id")!);
  if(!site) throw new PanelError(404, "Unknown site");
  return site;
}

/**
 * Members, hub roles, who manages each site and who has which role on it, and templates. Mounted
 * under `/api`, after the session check.
 */
export const access = new Hono<AppEnv>()
  .get("/members", async c => {
    const me = await hubAccess(c.env, c.get("session"));
    if(!me.member) throw new PanelError(403, "Only members of the panel can see its members");
    return c.json({ ...await listMembers(c.env), roles: await listHubRoles(c.env), permissions: HUB_PERMISSIONS, me: { sub: me.sub, role: me.role, permissions: me.permissions } });
  })

  .post("/members", body, async c => c.json(await inviteMember(c.env, await hubAccess(c.env, c.get("session")), c.req.valid("json")), 201))

  .patch("/members/:id", body, async c => c.json(await updateMember(c.env, await hubAccess(c.env, c.get("session")), c.req.param("id"), c.req.valid("json"))))

  .delete("/members/:id", async c => {
    await removeMember(c.env, await hubAccess(c.env, c.get("session")), c.req.param("id"));
    return c.body(null, 204);
  })

  .put("/hub-roles/:name", body, async c => {
    await saveHubRole(c.env, await hubAccess(c.env, c.get("session")), c.req.param("name"), c.req.valid("json").permissions);
    return c.json({ roles: await listHubRoles(c.env) });
  })

  .delete("/hub-roles/:name", async c => {
    await deleteHubRole(c.env, await hubAccess(c.env, c.get("session")), c.req.param("name"));
    return c.json({ roles: await listHubRoles(c.env) });
  })

  .get("/sites/:id/access", async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    await requireVisibleSite(c.env, me, site.id);
    return c.json({ ...await siteAccess(c.env, me, site), me: { admin: me.admin } });
  })

  /** The site's own roles, for pickers. */
  .get("/sites/:id/roles", async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    await requireSiteManager(c.env, me, site.id);
    return c.json({ roles: await siteRoles(c.env, site, me.sub) });
  })

  .put("/sites/:id/assignments", body, async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    return c.json(await assign(c.env, me, site, c.req.valid("json")));
  })

  .delete("/sites/:id/assignments/:principal", async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    await unassign(c.env, me, site, c.req.param("principal"));
    return c.body(null, 204);
  })

  .post("/sites/:id/owners", body, async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    await grantSite(c.env, me, site.id, c.req.valid("json").sub);
    return c.body(null, 204);
  })

  .delete("/sites/:id/owners/:sub", async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    await revokeSite(c.env, me, site.id, c.req.param("sub"));
    return c.body(null, 204);
  })

  /** Re-applies a template to a site that's already added. `replace` drops the site's roles that aren't in it. */
  .post("/sites/:id/template", body, async c => {
    const me = await hubAccess(c.env, c.get("session"));
    const site = await siteFor(c);
    await requireSiteManager(c.env, me, site.id);
    const { templateId, replace } = c.req.valid("json");
    if(typeof templateId !== "string") throw new PanelError(400, "Expected templateId");
    return c.json(await applyTemplate(c.env, site, templateId, me.sub, replace === true));
  })

  .get("/templates", async c => c.json({ templates: await listTemplates(c.env) }))

  .post("/templates", body, async c => c.json(await saveTemplate(c.env, await hubAccess(c.env, c.get("session")), null, c.req.valid("json")), 201))

  .put("/templates/:id", body, async c => c.json(await saveTemplate(c.env, await hubAccess(c.env, c.get("session")), c.req.param("id"), c.req.valid("json"))))

  .delete("/templates/:id", async c => {
    await deleteTemplate(c.env, await hubAccess(c.env, c.get("session")), c.req.param("id"));
    return c.body(null, 204);
  });
