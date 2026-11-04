import { expect } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineConfig } from "vibe-cms";
import { hub } from "vibe-cms/auth";
import { createHandler } from "vibe-cms/handler";
import v from "vibe-cms/schema";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { handle, type Env } from "../src/server/index.ts";

/** A mock identity provider, two sites (one trusting another hub) and a cookie-keeping panel client. */

export const ISSUER = "https://idp.test";
export const HUB = "https://panel.test";
export const CLIENT_ID = "panel-client";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" };

/** Which user the mock provider "signs in" next, and the nonce from the last authorize URL. */
export const idp = { email: "jane@agency.test", sub: "u-jane", nonce: "" };

export async function idToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ email: idp.email, email_verified: true, name: "Jane", nonce: idp.nonce, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(idp.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
}

export function site(hubUrl = HUB) {
  const config = defineConfig({
    auth: hub({ url: hubUrl }),
    permissions: { roles: { editor: { post: ["read", "write"] } }, users: { "jane@agency.test": ["editor"] } },
    schemas: { post: v.object({ title: v.text() }) }
  });
  const vibe = createHandler(config, { dev: false, bindings: (env: { DB: ReturnType<typeof createD1> }) => ({ db: env.DB }) });
  const env = { DB: createD1() };
  return (request: Request) => vibe.handle(request, env, { waitUntil() {} });
}

export const sites: Record<string, (request: Request) => Promise<Response>> = {
  "https://site-a.test": site(),
  "https://site-b.test": site("https://other-panel.test")
};

/** A mock site's ID, which the site makes for itself on first boot (as in production). */
export async function siteId(origin: string): Promise<string> {
  const response = await sites[origin]!(new Request(`${origin}/.well-known/vibe-cms`));
  return (await response.json() as { id: string }).id;
}

const realFetch = globalThis.fetch;

/** Routes fetches to the mock provider and the in-memory sites. Call from `beforeAll`. */
export function installMock() {
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
    // Sites fetch the hub's keys.
    if(url.origin === HUB) return handle(request, env);
    const handler = sites[url.origin];
    if(handler) return handler(request);
    return realFetch(input, init);
  }) as typeof fetch;
}

export function removeMock() {
  globalThis.fetch = realFetch;
}

export const env: Env = {
  DB: createD1() as unknown as D1Database,
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: "secret",
  PANEL_ALLOW: "agency.test",
  PANEL_URL: HUB
};

export const jar = new Map<string, string>();

export async function panel(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", [...jar].map(([k, v]) => `${k}=${v}`).join("; "));
  const response = await handle(new Request(`${HUB}${path}`, { ...init, headers }), env);
  for(const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";");
    const [name, value] = pair!.split("=");
    if(value) jar.set(name!, value);
    else jar.delete(name!);
  }
  return response;
}

export async function signIn(code = "good-code") {
  jar.clear();
  const login = await panel("/auth/login?return=/s/site-a/");
  const authorize = new URL(login.headers.get("location")!);
  expect(authorize.origin).toBe(ISSUER);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  idp.nonce = authorize.searchParams.get("nonce")!;
  return panel(`/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
}
