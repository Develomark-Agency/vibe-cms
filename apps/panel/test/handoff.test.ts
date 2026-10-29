import { afterAll, beforeAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineConfig } from "vibe-cms";
import { oidc } from "vibe-cms/auth";
import { createHandler } from "vibe-cms/handler";
import v from "vibe-cms/schema";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { handle, type Env } from "../src/server/index.ts";

const ISSUER = "https://idp.test";
const CLIENT_ID = "panel-client";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" };

/** Which user the mock provider "signs in" next, and the nonce from the last authorize URL. */
const idp = { email: "jane@agency.test", sub: "u-jane", nonce: "" };

async function idToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ email: idp.email, email_verified: true, name: "Jane", nonce: idp.nonce, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(idp.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
}

function site(id: string, issuer = ISSUER) {
  const config = defineConfig({
    id,
    name: `Site ${id}`,
    auth: oidc({ issuer, clientId: CLIENT_ID }),
    permissions: { roles: { editor: { post: ["read", "write"] } }, users: { "jane@agency.test": ["editor"] } },
    schemas: { post: v.object({ title: v.text() }) }
  });
  const vibe = createHandler(config, { dev: false, bindings: (env: { DB: ReturnType<typeof createD1> }) => ({ db: env.DB }) });
  const env = { DB: createD1() };
  return (request: Request) => vibe.handle(request, env, { waitUntil() {} });
}

const sites: Record<string, (request: Request) => Promise<Response>> = {
  "https://site-a.test": site("site-a"),
  "https://site-b.test": site("site-b", "https://other-idp.test")
};

const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if(url.origin === ISSUER) {
      if(url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`
        });
      }
      if(url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if(url.pathname === "/token") {
        const body = new URLSearchParams(await request.text());
        if(body.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(body.get("code_verifier")).toBeTruthy();
        return Response.json({ id_token: await idToken(), refresh_token: "r1" });
      }
    }
    const handler = sites[url.origin];
    if(handler) return handler(request);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

const env: Env = {
  DB: createD1() as unknown as D1Database,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: "secret",
  PANEL_ALLOW: "agency.test"
};

const jar = new Map<string, string>();

async function panel(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await handle(new Request(`https://panel.test${path}`, { ...init, headers }), env);
  for(const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [name, value] = pair!.split("=");
    if(value) jar.set(name!, value);
    else jar.delete(name!);
  }
  return response;
}

async function signIn(code = "good-code") {
  jar.clear();
  const login = await panel("/auth/login?return=/s/site-a/");
  const authorize = new URL(login.headers.get("location")!);
  expect(authorize.origin).toBe(ISSUER);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  idp.nonce = authorize.searchParams.get("nonce")!;
  return panel(`/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
}

test("sign-in, adding a site, and the one-time code handoff", async () => {
  const callback = await signIn();
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("https://panel.test/s/site-a/");
  expect(await (await panel("/api/me")).json()).toEqual({ name: "Jane", email: "jane@agency.test" });

  const added = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-a.test" }) });
  expect(added.status).toBe(201);
  const refused = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-b.test" }) });
  expect(refused.status).toBe(422);
  expect((await refused.json() as { error: string }).error).toBe("This site trusts a different identity provider");

  await panel("/api/sites/site-a/favorite", { method: "PUT" });
  expect(await (await panel("/api/sites")).json()).toEqual([
    { id: "site-a", url: "https://site-a.test", name: "Site site-a", admin: "https://site-a.test/_vibe/admin", favorite: true }
  ]);

  const { code } = await (await panel("/api/sites/site-a/code", { method: "POST" })).json() as { code: string };
  expect(code).toBeTruthy();

  // The editor trades the code for a site session token, once.
  const siteA = sites["https://site-a.test"]!;
  const exchange = await siteA(new Request("https://site-a.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) }));
  const session = await exchange.json() as { token: string, user: { sub: string, roles: string[] } };
  expect(session.user).toMatchObject({ sub: `${ISSUER}|u-jane`, roles: ["editor"] });
  const me = await siteA(new Request("https://site-a.test/_vibe/api/session", { headers: { authorization: `Bearer ${session.token}` } }));
  expect(me.status).toBe(200);
  const replay = await siteA(new Request("https://site-a.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) }));
  expect(replay.status).toBe(401);

  // Full-page mode: the code travels in the fragment.
  const go = await panel("/go/site-a");
  expect(go.headers.get("location")).toMatch(/^https:\/\/site-a\.test\/_vibe\/admin\/#code=.+/);
});

test("a site refuses users it gives no role", async () => {
  idp.email = "bob@agency.test";
  idp.sub = "u-bob";
  await signIn();
  const response = await panel("/api/sites/site-a/code", { method: "POST" });
  expect(response.status).toBe(403);
  expect((await response.json() as { error: string }).error).toBe("No access to this site");
});

test("PANEL_ALLOW keeps other accounts out of the panel", async () => {
  idp.email = "eve@elsewhere.test";
  idp.sub = "u-eve";
  const callback = await signIn();
  expect(decodeURIComponent(callback.headers.get("location")!)).toContain("isn't allowed to use this panel");
  expect((await panel("/api/me")).status).toBe(401);
});

test("a callback without the login cookie is refused", async () => {
  const login = await panel("/auth/login");
  const state = new URL(login.headers.get("location")!).searchParams.get("state");
  jar.clear();
  const callback = await panel(`/auth/callback?code=good-code&state=${state}`);
  expect(decodeURIComponent(callback.headers.get("location")!)).toContain("Sign-in expired");
});
