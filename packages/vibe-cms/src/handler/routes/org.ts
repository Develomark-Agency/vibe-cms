import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import { require } from "../auth.ts";
import { jsonInput, type SiteEnv } from "../http.ts";
import { needsSetup } from "../signin.ts";

/** The org whose hub the site trusts, and moving to another one. */
export const org = new Hono<SiteEnv>()
  .get("/org", async c => {
    const { state } = c.env;
    require(state, c.get("session"), { action: "write", scope: "site" });
    return c.json({ ...await state.org.status(), history: await state.org.history() });
  })

  // Hub → site, server to server: a hub claiming a site that has no org, with the token from the site's log.
  .post("/org/claim", jsonInput<{ token?: string, org?: string }>(), async c => {
    const { state } = c.env;
    const { token, org } = c.req.valid("json");
    if(!token || !org) throw new HttpError(400, "Expected token and org");
    // A site that already has its own owners is theirs to move into an org, with VIBE_ORG.
    if(!await state.org.current() && !await needsSetup(state)) throw new HttpError(409, "This site already has its own owners. To put it in an org, set VIBE_ORG in its environment");
    return c.json(await state.org.claim(token, org));
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
    const user = require(state, c.get("session"), { action: "write", scope: "site" });
    return c.json(await state.org.cancelMove(user.email ?? user.sub));
  });
