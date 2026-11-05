import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { completeClaims, exchangeCode, identityOf, isAllowed, randomString, verifyIdToken } from "../oidc.ts";
import { completeAuthorization } from "../oauth.ts";
import { admitSignIn } from "../access.ts";
import * as t from "../schema.ts";
import { beginLogin, cookie, db, LOGIN_COOKIE, oidcConfig, SESSION_COOKIE, SESSION_TTL, setCookie } from "../shared.ts";
import type { AppContext, AppEnv } from "../context.ts";

async function login(c: AppContext) {
  const url = new URL(c.req.url);
  let returnTo = url.searchParams.get("return") ?? "/";
  if(!returnTo.startsWith("/") || returnTo.startsWith("//")) returnTo = "/";
  // The hub's one-time setup link: carried through the sign-in, checked at the callback.
  const setup = url.searchParams.get("setup");
  if(setup) returnTo += `${returnTo.includes("?") ? "&" : "?"}setup=${encodeURIComponent(setup)}`;
  return beginLogin(c.env, url, returnTo);
}

async function callback(c: AppContext) {
  const env = c.env;
  const url = new URL(c.req.url);
  function fail(message: string) {
    return Response.redirect(`${url.origin}/?error=${encodeURIComponent(message)}`, 302);
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if(url.searchParams.get("error")) return fail(url.searchParams.get("error_description") ?? url.searchParams.get("error")!);
  if(!state || !code || cookie(c.req.raw, LOGIN_COOKIE) !== state) return fail("Sign-in expired. Try again.");
  const [pending] = await db(env).delete(t.logins).where(eq(t.logins.state, state)).returning();
  if(!pending || pending.expires_at < Date.now()) return fail("Sign-in expired. Try again.");
  const config = oidcConfig(env);
  let claims;
  let tokens;
  try {
    tokens = await exchangeCode(config, { code, redirectUri: `${url.origin}/auth/callback`, verifier: pending.verifier });
    claims = await completeClaims(config, await verifyIdToken(config, tokens.id_token, pending.nonce), tokens);
  } catch (error) {
    return fail(`Sign-in failed: ${(error as Error).message}`);
  }
  if(!isAllowed(env.PANEL_ALLOW, claims, config)) return fail("Your account isn't allowed to use this panel.");
  const identity = identityOf(config, claims);
  const returnUrl = pending.return_to.startsWith("oauth:") ? null : new URL(pending.return_to, url.origin);
  const setup = returnUrl?.searchParams.get("setup") ?? null;
  returnUrl?.searchParams.delete("setup");
  const refused = await admitSignIn(env, { sub: `${claims.iss}|${claims.sub}`, ...identity }, setup);
  if(refused) return fail(refused);
  if(pending.return_to.startsWith("oauth:")) return completeAuthorization(env, url, pending.return_to.slice(6), claims, tokens);
  const id = randomString();
  await db(env).insert(t.sessions).values({
    id,
    sub: `${claims.iss}|${claims.sub}`,
    email: identity.email ?? null,
    name: identity.name ?? null,
    id_token: tokens.id_token,
    refresh_token: tokens.refresh_token ?? null,
    expires_at: Date.now() + SESSION_TTL
  });
  const headers = new Headers({ location: `${url.origin}${returnUrl!.pathname}${returnUrl!.search}` });
  headers.append("set-cookie", setCookie(url, SESSION_COOKIE, id, SESSION_TTL / 1000));
  headers.append("set-cookie", setCookie(url, LOGIN_COOKIE, "", 0));
  return new Response(null, { status: 302, headers });
}

async function logout(c: AppContext) {
  const id = cookie(c.req.raw, SESSION_COOKIE);
  if(id) await db(c.env).delete(t.sessions).where(eq(t.sessions.id, id));
  return new Response(null, { status: 204, headers: { "set-cookie": setCookie(new URL(c.req.url), SESSION_COOKIE, "", 0) } });
}

/** Signing in to the panel through the identity provider, at `/auth`. */
export const auth = new Hono<AppEnv>()
  .get("/login", login)
  .get("/callback", callback)
  .post("/logout", logout);
