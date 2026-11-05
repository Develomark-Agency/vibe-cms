import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import type { Session } from "../../server/index.ts";
import { consumeCode, createCode, DEV_SESSION, issueSession, permissionSummary, sessionFromHubToken } from "../auth.ts";
import {
  authenticate,
  authenticationOptions,
  needsSetup,
  oidcCallback,
  oidcLogin,
  register,
  registrationOptions,
  resume,
  SIGNIN_COOKIE,
  signInMode,
  signOut
} from "../signin.ts";
import { jsonInput, readCookie, type SiteEnv } from "../http.ts";
import { recordHubUser } from "../roles.ts";

/** Who is signed in, and how people sign in: the editor's session, a site's own passkeys or identity provider. */
export const auth = new Hono<SiteEnv>()
  .get("/session", c => {
    const session = c.get("session");
    if(!session) {
      // No credentials at all is a normal "not signed in", not an error; a bad token is.
      if(c.req.header("authorization")) throw new HttpError(401, "Session expired");
      return c.json({ user: null });
    }
    return c.json({ user: session, permissions: permissionSummary(c.env.state, session) });
  })

  .post("/session", jsonInput<{ code?: string, dev?: boolean, resume?: boolean }>(), async c => {
    const { state, dev } = c.env;
    const url = new URL(c.req.url);
    const input = c.req.valid("json");
    let next: Session;
    if(input.dev) {
      if(!dev) throw new HttpError(403, "Dev sessions are only available in development");
      next = DEV_SESSION;
    } else if(input.code) {
      next = await consumeCode(state.db, input.code);
    } else if(input.resume) {
      // The signed-in browser's cookie, for sites that sign people in themselves. Only from the site's own pages.
      const origin = c.req.header("origin");
      if(origin && origin !== url.origin) throw new HttpError(403, "Cross-origin request refused");
      const resumed = await resume(state, readCookie(c.req.raw, SIGNIN_COOKIE));
      if(!resumed) throw new HttpError(401, "Not signed in");
      next = resumed;
    } else {
      throw new HttpError(400, "Expected a code");
    }
    // Kept in the editor's memory: it only ever runs framed by the hub, or locally in development.
    const { token, expiresAt } = await issueSession(state.db, next, state.siteId, url.origin);
    return c.json({ token, expiresAt, user: next, permissions: permissionSummary(state, next) });
  })

  .delete("/session", async c => {
    const { state } = c.env;
    return c.json({ ok: true }, 200, { "set-cookie": await signOut(state, new URL(c.req.url), readCookie(c.req.raw, SIGNIN_COOKIE)) });
  })

  // Hub → site, server to server: a token the hub signed for this site in, a one-time code out.
  .post("/session/code", jsonInput<{ token?: string }>(), async c => {
    const { state } = c.env;
    const { token } = c.req.valid("json");
    if(!token) throw new HttpError(400, "Expected token");
    const next = await sessionFromHubToken(state, token);
    if(!next || next.grants) throw new HttpError(401, "Not a sign-in token from this site's hub");
    await recordHubUser(state.db, next, next.roles.includes("owner")).catch(() => {});
    return c.json({ code: await createCode(state.db, next), expiresIn: 30 });
  })

  // How the editor offers sign-in.
  .get("/auth", async c => {
    const { state } = c.env;
    const mode = await signInMode(state);
    return c.json({
      mode,
      setup: await needsSetup(state),
      email: Boolean(state.signIn.email),
      provider: mode === "oidc" ? new URL(state.signIn.oidc!.issuer).host : null
    });
  })

  .post("/auth/passkey/register/options", jsonInput<{ invite?: string, setup?: string, email?: string, name?: string }>(), async c => {
    return c.json(await registrationOptions(c.env.state, new URL(c.req.url), c.req.valid("json")));
  })

  .post("/auth/passkey/register", jsonInput<{ challengeId: string, response: unknown }>(), async c => {
    const { cookie } = await register(c.env.state, new URL(c.req.url), c.req.valid("json"));
    return c.json({ ok: true }, 200, { "set-cookie": cookie });
  })

  .post("/auth/passkey/login/options", async c => c.json(await authenticationOptions(c.env.state, new URL(c.req.url))))

  .post("/auth/passkey/login", jsonInput<{ challengeId: string, response: unknown }>(), async c => {
    const { cookie } = await authenticate(c.env.state, new URL(c.req.url), c.req.valid("json"));
    return c.json({ ok: true }, 200, { "set-cookie": cookie });
  })

  .get("/auth/oidc/login", c => oidcLogin(c.env.state, new URL(c.req.url)))
  .get("/auth/oidc/callback", c => oidcCallback(c.env.state, new URL(c.req.url), readCookie(c.req.raw, "vibe_login")));
