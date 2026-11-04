import { Hono } from "hono";
import type { Next } from "hono";
import { HttpError } from "../../config.ts";
import { Engine } from "../engine.ts";
import * as oauth from "../oauth.ts";
import { cookieIdentity, SIGNIN_COOKIE } from "../signin.ts";
import { json, jsonInput, readCookie, type SiteContext, type SiteEnv } from "../http.ts";

/**
 * The site as an OAuth server for agents and the CLI, when it signs people in itself: the metadata
 * agents look for (at the root, and under the prefix) and the endpoints they register and get tokens at.
 */
export function oauthServer(prefix: string) {
  const app = new Hono<SiteEnv>();
  const known = oauth.wellKnownPaths(prefix);
  const endpoints = ["register", "authorize", "token", "revoke", "code"].map(name => `${prefix}/oauth/${name}`);

  async function serving(c: SiteContext, next: Next) {
    const { state, dev } = c.env;
    // In development, agents and the CLI get in as the developer without signing in.
    if(dev) return json({ error: "Development sites let agents and the CLI in without signing in" }, { status: 404 });
    if(!await oauth.servesOAuth(state)) return json({ error: "This site signs agents and the CLI in through its org's hub" }, { status: 404 });
    await next();
  }

  for(const path of [...known.authorizationServer, ...known.protectedResource, ...endpoints]) {
    app.use(path, serving);
    app.options(path, () => oauth.corsPreflight());
  }

  for(const path of known.authorizationServer) {
    app.get(path, c => oauth.authorizationServerMetadata(c.env.state, new URL(c.req.url)));
  }
  for(const path of known.protectedResource) {
    app.get(path, async c => {
      const { state, ctx } = c.env;
      const url = new URL(c.req.url);
      const site = await new Engine(state, { origin: url.origin, session: null, trusted: false, ctx }).site();
      return oauth.protectedResourceMetadata(state, url, site.name);
    });
  }

  app.post(`${prefix}/oauth/register`, c => oauth.register(c.env.state, c.req.raw));
  app.get(`${prefix}/oauth/authorize`, c => oauth.authorize(c.env.state, new URL(c.req.url)));
  app.post(`${prefix}/oauth/token`, c => oauth.token(c.env.state, c.req.raw));
  app.post(`${prefix}/oauth/revoke`, c => oauth.revoke(c.env.state, c.req.raw));
  app.get(`${prefix}/oauth/code`, c => oauth.codePage(new URL(c.req.url)));
  return app;
}

function signedIn(c: SiteContext) {
  const session = c.get("session");
  if(!session) throw new HttpError(401, "Sign in required");
  return session;
}

/** Connecting an agent or the CLI, from the editor: it shows the request, and posts the signed-in user's answer. */
export const connections = new Hono<SiteEnv>()
  .get("/oauth/request", async c => {
    signedIn(c);
    return c.json(await oauth.describeRequest(c.env.state, c.req.query("id") ?? null));
  })

  .post("/oauth/decide", jsonInput<{ request: string, allow: boolean, readOnly?: boolean }>(), async c => {
    const session = signedIn(c);
    const identity = await cookieIdentity(c.env.state, readCookie(c.req.raw, SIGNIN_COOKIE));
    return c.json(await oauth.decide(c.env.state, new URL(c.req.url), session, identity, c.req.valid("json")));
  })

  .get("/oauth/connections", async c => c.json({ connections: await oauth.listGrants(c.env.state, signedIn(c).sub) }))

  .delete("/oauth/connections/:id", async c => {
    await oauth.disconnect(c.env.state, signedIn(c).sub, c.req.param("id"));
    return c.json({ ok: true });
  });
