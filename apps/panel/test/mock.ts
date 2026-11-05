import { expect } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { defineConfig } from "vibe-cms";
import { createHandler } from "vibe-cms/handler";
import v from "vibe-cms/schema";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { handle, type Env } from "../src/server/index.ts";

/** A mock identity provider, two sites (one trusting another hub) and a cookie-keeping panel client. */

export const ISSUER = "https://idp.test";
export const HUB = "https://panel.test";
/** The hub's org, found through DNS: `_vibe-hub.agency.test` points at the hub. */
export const ORG = "agency.test";

/** Addresses the mock hub answers on: its own, plus any a test moves it to. */
export const hubOrigins = new Set([HUB]);

/** The mock DNS: TXT records by name, answered over DNS-over-HTTPS like cloudflare-dns.com. */
export const txt: Record<string, string> = {
  "_vibe-hub.agency.test": HUB,
  "_vibe-hub.other.test": "https://other-panel.test"
};

const signing = await generateKeyPair("ES256", { extractable: true });
export const SIGNING_KEY = JSON.stringify({ ...(await exportJWK(signing.privateKey)), kid: "hub-1" });
export const CLIENT_ID = "panel-client";
const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256" };

/** Which user the mock provider "signs in" next, and the nonce from the last authorize URL. */
export const idp: { email: string, sub: string, nonce: string, claims: Record<string, unknown>, refresh: "id_token" | "none" } = {
  email: "jane@agency.test",
  sub: "u-jane",
  nonce: "",
  /** Overrides of the ID token's claims; `undefined` leaves one out (some providers send no `email_verified`). */
  claims: {},
  /** What a refresh returns: a new ID token, or only a new refresh token. */
  refresh: "id_token"
};

export async function idToken(claims: Record<string, unknown> = {}) {
  return new SignJWT({ email: idp.email, email_verified: true, name: "Jane", nonce: idp.nonce, ...claims, ...idp.claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .setSubject(idp.sub)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(keys.privateKey);
}

export function site(org = ORG, siteEnv: Record<string, unknown> = {}) {
  const config = defineConfig({
    permissions: { roles: { editor: { post: ["read", "write"] } }, users: { "jane@agency.test": ["editor"] } },
    schemas: { post: v.object({ title: v.text() }) }
  });
  const vibe = createHandler(config, { dev: false, bindings: (env: { DB: ReturnType<typeof createD1> }) => ({ db: env.DB }) });
  const env = { DB: createD1(), VIBE_ORG: org, ...siteEnv };
  return (request: Request) => vibe.handle(request, env, { waitUntil() {} });
}

export const sites: Record<string, (request: Request) => Promise<Response>> = {
  "https://site-a.test": site(),
  "https://site-b.test": site("other.test")
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
    if(url.origin === "https://cloudflare-dns.com") {
      const name = url.searchParams.get("name")!;
      const value = txt[name];
      return Response.json({ Status: value ? 0 : 3, Answer: value ? [{ name, type: 16, TTL: 300, data: `"${value}"` }] : [] });
    }
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
        if(body.get("grant_type") === "refresh_token") {
          return Response.json(idp.refresh === "none" ? { access_token: "at-2", refresh_token: "r2" } : { id_token: await idToken(), refresh_token: "r2" });
        }
        if(body.get("code") !== "good-code") return Response.json({ error: "invalid_grant" }, { status: 400 });
        expect(body.get("code_verifier")).toBeTruthy();
        return Response.json({ id_token: await idToken(), refresh_token: "r1" });
      }
    }
    // Sites fetch the hub's keys, at whichever address the org's DNS record names.
    if(hubOrigins.has(url.origin)) return handle(request, env);
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
  PANEL_URL: HUB,
  VIBE_ORG: ORG,
  HUB_SIGNING_KEY: SIGNING_KEY
};

export const jar = new Map<string, string>();

export async function panel(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  // Clients send JSON as JSON; the routes that read a body insist on it.
  if(typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
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

/** The hub's setup token while it has no owner: what the printed link carries. */
export async function setupToken(): Promise<string | null> {
  const row = await (env.DB as unknown as ReturnType<typeof createD1>).prepare("SELECT value FROM panel_meta WHERE key = 'setup_token'").first() as { value: string } | null;
  return row?.value ?? null;
}

/**
 * Signs in through the mock provider. A hub with no owner is claimed by Jane first, with the setup
 * link, so tests start from a panel that has one (`setup: false` tries without the link).
 */
export async function signIn(code = "good-code", options: { setup?: boolean } = {}) {
  jar.clear();
  // Makes the setup token, as the first request to an unowned hub does.
  await panel("/api/setup");
  const token = options.setup === false ? null : await setupToken();
  // Jane owns the hub in every test, whoever signs in first.
  if(token && idp.sub !== "u-jane") {
    const who = { email: idp.email, sub: idp.sub };
    Object.assign(idp, { email: "jane@agency.test", sub: "u-jane" });
    await signIn(code);
    Object.assign(idp, who);
    jar.clear();
  }
  const login = await panel(`/auth/login?return=/s/site-a/${token && idp.sub === "u-jane" ? `&setup=${token}` : ""}`);
  const authorize = new URL(login.headers.get("location")!);
  expect(authorize.origin).toBe(ISSUER);
  expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
  idp.nonce = authorize.searchParams.get("nonce")!;
  return panel(`/auth/callback?code=${code}&state=${authorize.searchParams.get("state")}`);
}

/** Gives someone roles on a site from the hub, as an admin would on the site's Access tab. */
export async function assignRoles(siteId: string, sub: string, roles: string[]) {
  const d1 = env.DB as unknown as ReturnType<typeof createD1>;
  if(!roles.length) return void await d1.prepare("DELETE FROM site_assignments WHERE site_id = ? AND principal = ?").bind(siteId, `${ISSUER}|${sub}`).run();
  await (env.DB as unknown as ReturnType<typeof createD1>)
    .prepare("INSERT OR REPLACE INTO site_assignments (site_id, principal, roles, assigned_by, assigned_at) VALUES (?, ?, ?, 'test', 0)")
    .bind(siteId, `${ISSUER}|${sub}`, JSON.stringify(roles)).run();
}
