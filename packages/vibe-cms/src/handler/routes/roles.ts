import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import { applyRoles, deleteRole, listRoles, presets, roleSchema, saveRole } from "../roles.ts";
import { jsonInput, type SiteEnv } from "../http.ts";

/** The site's roles: stored in its database, edited on the Roles page, written by the hub from templates. */
export const roles = new Hono<SiteEnv>()
  .get("/roles", c => c.json(listRoles(c.env.state, c.get("session"))))

  .get("/roles/presets", c => {
    if(!c.get("session")) throw new HttpError(401, "Sign in required");
    return c.json({ presets: presets(c.env.state) });
  })

  .get("/roles/schema", c => {
    if(!c.get("session")) throw new HttpError(401, "Sign in required");
    return c.json(roleSchema(c.env.state.config));
  })

  // Several roles at once: the hub applying a template. `replace: true` removes roles not listed.
  .post("/roles/apply", jsonInput<{ roles: Record<string, unknown>, replace?: boolean }>(), async c => {
    return c.json(await applyRoles(c.env.state, c.get("session"), c.req.valid("json")));
  })

  .put("/roles/:name", jsonInput<{ rules: unknown }>(), async c => {
    return c.json({ role: await saveRole(c.env.state, c.get("session"), c.req.param("name"), c.req.valid("json")) });
  })

  .delete("/roles/:name", async c => {
    await deleteRole(c.env.state, c.get("session"), c.req.param("name"));
    return c.json({ ok: true });
  });
