import { Hono } from "hono";
import { invite, listUsers, removeUser, signInMode, updateUser } from "../signin.ts";
import { require } from "../auth.ts";
import { fullRoleManager, outOfReach } from "../roles.ts";
import { jsonInput, type SiteEnv } from "../http.ts";

/** Who may sign in to a site that signs people in itself, and as what. */
export const users = new Hono<SiteEnv>()
  .get("/users", async c => {
    const { state } = c.env;
    require(state, c.get("session"), { action: "read", scope: "users" });
    const mode = await signInMode(state);
    const roles = ["owner", ...Object.keys(state.roles.map)];
    // Org sites: who the hub signed in, and as what. Assignments are edited on the hub.
    const hub = mode === "hub";
    const session = c.get("session")!;
    // The roles this person may give out: all of them for owners, else those within their own.
    const assignable = roles.filter(role => (role === "owner" ? fullRoleManager(state, session) : !outOfReach(state, session, state.roles.map[role])));
    // Org sites: the editor asks the panel who has which role (the hub decides), so nothing to list here.
    return c.json({ users: hub ? [] : await listUsers(state), mode, roles, assignable });
  })

  .post("/users/invites", jsonInput<{ email: string, roles: string[] }>(), async c => {
    const { state } = c.env;
    const by = require(state, c.get("session"), { action: "write", scope: "users" });
    return c.json(await invite(state, new URL(c.req.url).origin, by, c.req.valid("json")), 201);
  })

  .patch("/users/:id", jsonInput<{ roles: string[] }>(), async c => {
    const { state } = c.env;
    const by = require(state, c.get("session"), { action: "write", scope: "users" });
    return c.json(await updateUser(state, by, c.req.param("id"), c.req.valid("json")));
  })

  .delete("/users/:id", async c => {
    const { state } = c.env;
    const by = require(state, c.get("session"), { action: "delete", scope: "users" });
    await removeUser(state, by, c.req.param("id"));
    return c.json({ ok: true });
  });
