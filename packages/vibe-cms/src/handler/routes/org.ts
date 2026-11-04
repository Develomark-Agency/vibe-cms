import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import { require } from "../auth.ts";
import { jsonInput, type SiteEnv } from "../http.ts";

/** The org whose hub the site trusts, and moving to another one. */
export const org = new Hono<SiteEnv>()
  .get("/org", async c => {
    const { state } = c.env;
    require(state.config, c.get("session"), { action: "write", scope: "site" });
    return c.json({ ...await state.org.status(), history: await state.org.history() });
  })

  // Hub → site, server to server: a move to another org, signed by the current org's hub.
  .post("/org/move", jsonInput<{ token?: string }>(), async c => {
    const { state } = c.env;
    const { token } = c.req.valid("json");
    if(!token) throw new HttpError(400, "Expected token");
    return c.json(await state.org.requestMove(token, state.siteId));
  })

  .delete("/org/move", async c => {
    const { state } = c.env;
    const user = require(state.config, c.get("session"), { action: "write", scope: "site" });
    return c.json(await state.org.cancelMove(user.email ?? user.sub));
  });
