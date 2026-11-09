import { Hono } from "hono";
import { DEV_SESSION } from "../auth.ts";
import { Engine } from "../engine.ts";
import { handleMcp } from "../mcp.ts";
import * as oauth from "../oauth.ts";
import { json, type SiteEnv } from "../http.ts";

/** `/api/mcp`: the site as an MCP server, for agents. */
export const mcp = new Hono<SiteEnv>();

mcp.options("/mcp", () => oauth.corsPreflight());

mcp.all("/mcp", async c => {
  const { state, dev, ctx } = c.env;
  const url = new URL(c.req.url);
  const session = c.get("session");
  // Development sites let local agents in as the developer, like the editor's dev sign-in.
  const agent = session ?? (dev ? DEV_SESSION : null);
  // A site that signs people in itself points agents at its own sign-in.
  if(!agent && await oauth.servesOAuth(state)) return oauth.unauthorized(state, url, c.req.raw.headers.has("authorization"));
  if(!agent) {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "This site only lets agents in with a site session token (`Authorization: Bearer <token>`). For deployed sites, connect the agent to your agency panel's /mcp instead: it signs the agent in and covers every site in the panel." } },
      { status: 401, headers: { "www-authenticate": "Bearer" } }
    );
  }
  const scoped = new Engine(state, { origin: url.origin, session: agent, trusted: false, ctx });
  return handleMcp(c.req.raw, { engine: scoped }, state.plugins);
});
