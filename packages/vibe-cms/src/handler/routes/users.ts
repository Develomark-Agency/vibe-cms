import { Hono } from "hono";
import { invite, listUsers, removeUser, signInMode, updateUser } from "../signin.ts";
import { require } from "../auth.ts";
import { fullRoleManager, outOfReach } from "../roles.ts";
import { audited } from "../activity.ts";
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
    // A list of people's emails: a sensitive read.
    const list = hub ? [] : await audited(c.get("engine"), { action: "users.list", targetType: "users" }, () => listUsers(state));
    return c.json({ users: list, mode, roles, assignable });
  })

  .post("/users/invites", jsonInput<{ email: string, roles: string[] }>(), async c => {
    const { state } = c.env;
    const { roles } = c.req.valid("json");
    return c.json(await audited(c.get("engine"), { action: "users.invite", targetType: "users", summary: { roles } }, () => {
      const by = require(state, c.get("session"), { action: "write", scope: "users" });
      return invite(state, new URL(c.req.url).origin, by, c.req.valid("json"));
    }), 201);
  })

  .patch("/users/:id", jsonInput<{ roles: string[] }>(), async c => {
    const { state } = c.env;
    const { roles } = c.req.valid("json");
    return c.json(await audited(c.get("engine"), { action: "users.update", targetType: "users", targetId: c.req.param("id"), summary: { roles } }, () => {
      const by = require(state, c.get("session"), { action: "write", scope: "users" });
      return updateUser(state, by, c.req.param("id"), c.req.valid("json"));
    }));
  })

  .delete("/users/:id", async c => {
    const { state } = c.env;
    await audited(c.get("engine"), { action: "users.remove", targetType: "users", targetId: c.req.param("id") }, () => {
      const by = require(state, c.get("session"), { action: "delete", scope: "users" });
      return removeUser(state, by, c.req.param("id"));
    });
    return c.json({ ok: true });
  });
