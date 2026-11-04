import { Hono } from "hono";
import { invite, listUsers, removeUser, signInMode, updateUser } from "../signin.ts";
import { require } from "../auth.ts";
import { jsonInput, type SiteEnv } from "../http.ts";

/** Who may sign in to a site that signs people in itself, and as what. */
export const users = new Hono<SiteEnv>()
  .get("/users", async c => {
    const { state } = c.env;
    require(state.config, c.get("session"), { action: "read", scope: "users" });
    return c.json({ users: await listUsers(state), mode: await signInMode(state), roles: ["owner", ...Object.keys(state.config.permissions?.roles ?? {})] });
  })

  .post("/users/invites", jsonInput<{ email: string, roles: string[] }>(), async c => {
    const { state } = c.env;
    const by = require(state.config, c.get("session"), { action: "write", scope: "users" });
    return c.json(await invite(state, new URL(c.req.url).origin, by, c.req.valid("json")), 201);
  })

  .patch("/users/:id", jsonInput<{ roles: string[] }>(), async c => {
    const { state } = c.env;
    require(state.config, c.get("session"), { action: "write", scope: "users" });
    return c.json(await updateUser(state, c.req.param("id"), c.req.valid("json")));
  })

  .delete("/users/:id", async c => {
    const { state } = c.env;
    require(state.config, c.get("session"), { action: "delete", scope: "users" });
    await removeUser(state, c.req.param("id"));
    return c.json({ ok: true });
  });
