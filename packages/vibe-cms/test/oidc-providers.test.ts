import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { authorizationUrl, clearDiscoveryCache, claimValues, completeClaims, exchangeCode, identityOf, isAllowed, normalizeIssuer, refresh, verifyIdToken, type Discovery, type OidcConfig } from "../src/oidc/index.ts";

/**
 * The OIDC client against providers shaped like the ones people will use. Each profile is a small
 * provider with that provider's documented endpoints and habits; the rest are single quirks that
 * real providers have. Modeled on the providers' docs, not captured from live accounts.
 */

interface Profile {
  /** A path the provider lives under, like Cloudflare Access's per-application issuer. */
  path?: string,
  /** Fields of the discovery document, over the required ones. */
  discovery?: (base: string) => Partial<Discovery>,
  /** The ways the token endpoint accepts a client's credentials. */
  accepts?: Array<"basic" | "post">,
  /** The refresh response includes a new ID token. */
  refreshIdToken?: boolean,
  /** Gives out refresh tokens at all. */
  refreshTokens?: boolean,
  /** What the ID token says about the user. */
  claims?: Record<string, unknown>,
  /** What userinfo says; the endpoint is only advertised when this is set. */
  userinfo?: Record<string, unknown>,
  /** The issuer the provider reports, if not its address (Auth0 ends it with a slash). */
  issuer?: (base: string) => string
}

const keys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const servers: Array<ReturnType<typeof Bun.serve>> = [];

function provider(profile: Profile) {
  const accepts = profile.accepts ?? ["basic", "post"];
  const attempts: Array<"basic" | "post"> = [];
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const root = `${url.origin}${profile.path ?? ""}`;
      const path = url.pathname.slice((profile.path ?? "").length);
      requests.push(path);
      if(path === "/.well-known/openid-configuration") {
        return Response.json({
          issuer: profile.issuer?.(root) ?? root,
          authorization_endpoint: `${root}/authorization`,
          token_endpoint: `${root}/token`,
          jwks_uri: `${root}/jwks`,
          ...profile.userinfo ? { userinfo_endpoint: `${root}/userinfo` } : {},
          ...profile.discovery?.(root)
        });
      }
      if(path === "/jwks") return Response.json({ keys: [jwk] });
      if(path === "/userinfo") {
        return request.headers.get("authorization") === "Bearer at-1" ? Response.json(profile.userinfo) : new Response("no", { status: 401 });
      }
      if(path === "/token") {
        const form = new URLSearchParams(await request.text());
        const basic = request.headers.get("authorization")?.startsWith("Basic ");
        const method = basic ? "basic" : "post";
        attempts.push(method);
        const credentials = basic
          ? atob(request.headers.get("authorization")!.slice(6))
          : `${form.get("client_id")}:${form.get("client_secret")}`;
        if(!accepts.includes(method) || credentials !== "client-1:secret-1") return Response.json({ error: "invalid_client" }, { status: 401 });
        const iss = profile.issuer?.(root) ?? root;
        const idToken = await new SignJWT({ nonce: "n1", ...profile.claims })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(iss).setAudience("client-1").setSubject("user-1").setIssuedAt().setExpirationTime("1h")
          .sign(keys.privateKey);
        if(form.get("grant_type") === "refresh_token") {
          if(profile.refreshTokens === false) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json({ access_token: "at-2", refresh_token: "rt-2", ...profile.refreshIdToken === false ? {} : { id_token: idToken } });
        }
        if(!form.get("code_verifier")) return Response.json({ error: "invalid_request", error_description: "PKCE required" }, { status: 400 });
        return Response.json({ id_token: idToken, access_token: "at-1", ...profile.refreshTokens === false ? {} : { refresh_token: "rt-1" } });
      }
      return new Response("not found", { status: 404 });
    }
  });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const issuer = `${base}${profile.path ?? ""}`;
  const config: OidcConfig = { issuer, clientId: "client-1", clientSecret: "secret-1" };
  return { base, issuer, config, attempts, requests };
}

/** The whole sign-in as a client sees it: authorize URL, code for tokens, checked claims, completed from userinfo. */
async function signIn(config: OidcConfig) {
  const url = new URL(await authorizationUrl(config, { redirectUri: "https://app.test/cb", state: "s", nonce: "n1", verifier: "v".repeat(43) }));
  const tokens = await exchangeCode(config, { code: "c", redirectUri: "https://app.test/cb", verifier: "v".repeat(43) });
  const claims = await completeClaims(config, await verifyIdToken(config, tokens.id_token, "n1"), tokens);
  return { scope: url.searchParams.get("scope")!.split(" "), tokens, claims };
}

beforeEach(clearDiscoveryCache);
afterAll(() => {
  for(const server of servers) server.stop(true);
});

describe("Clerk (from its published OAuth metadata)", () => {
  const clerk: Profile = {
    discovery: () => ({
      scopes_supported: ["openid", "profile", "email", "public_metadata", "private_metadata", "offline_access", "user:org:read"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
      code_challenge_methods_supported: ["S256"],
      claims_supported: ["sub", "iss", "aud", "exp", "iat", "email", "name", "org_id"]
    }),
    accepts: ["basic"],
    claims: { email: "jane@agency.test", name: "Jane Doe" }
  };

  test("signs in, asks for offline_access because it's offered, and renews the session", async () => {
    const { config } = provider(clerk);
    const { scope, tokens } = await signIn(config);
    expect(scope).toEqual(["openid", "email", "profile", "offline_access"]);
    expect(tokens.refresh_token).toBe("rt-1");
    expect((await refresh(config, tokens.refresh_token!)).id_token).toBeTruthy();
  });

  test("an email with no email_verified claim isn't trusted until the config says to", async () => {
    const { config } = provider(clerk);
    const { claims } = await signIn(config);
    expect(identityOf(config, claims)).toEqual({ email: "jane@agency.test", emailVerified: false, name: "Jane Doe" });
    expect(isAllowed("agency.test", claims, config)).toBe(false);
    const trusting = { ...config, trustEmail: true };
    expect(identityOf(trusting, claims).emailVerified).toBe(true);
    expect(isAllowed("agency.test", claims, trusting)).toBe(true);
    expect(isAllowed("other.test", claims, trusting)).toBe(false);
  });

  test("a provider that says the email isn't verified wins over trusting it", async () => {
    const { config } = provider({ ...clerk, claims: { email: "jane@agency.test", email_verified: false } });
    const { claims } = await signIn({ ...config, trustEmail: true });
    expect(identityOf({ trustEmail: true }, claims).emailVerified).toBe(false);
  });
});

describe("Cloudflare Access SaaS OIDC (endpoints from its docs)", () => {
  // Per-application issuer under /cdn-cgi/access/sso/oidc/<client id>, with the scopes the docs list.
  const access: Profile = {
    path: "/cdn-cgi/access/sso/oidc/client-1",
    discovery: () => ({ scopes_supported: ["openid", "email", "profile", "groups"] }),
    claims: { email: "jane@agency.test", name: "Jane", groups: ["staff", "ops"] },
    refreshTokens: false
  };

  test("discovers under the application's issuer path, and doesn't ask for scopes it doesn't offer", async () => {
    const { config, requests } = provider(access);
    const { scope, tokens } = await signIn(config);
    expect(requests).toContain("/.well-known/openid-configuration");
    expect(scope).toEqual(["openid", "email", "profile"]);
    expect(tokens.refresh_token).toBeUndefined();
  });

  test("takes the dashboard's discovery URL as the issuer", async () => {
    const { config } = provider(access);
    const pasted = `${config.issuer}/.well-known/openid-configuration`;
    expect((await signIn({ ...config, issuer: pasted })).claims.sub).toBe("user-1");
    expect(normalizeIssuer(pasted)).toBe(config.issuer);
  });

  test("who may sign in follows Access groups, with no email_verified needed", async () => {
    const { config } = provider(access);
    const { claims } = await signIn(config);
    expect(isAllowed("staff", claims, config)).toBe(true);
    expect(isAllowed("contractors", claims, config)).toBe(false);
  });
});

describe("how providers differ", () => {
  test("a token endpoint that only takes credentials in the body is found by trying, and remembered", async () => {
    const { config, attempts } = provider({ accepts: ["post"], claims: { email: "a@b.test" } });
    await signIn(config);
    // Basic first (nothing said otherwise), then the body; later requests don't repeat the miss.
    expect(attempts).toEqual(["basic", "post"]);
    await refresh(config, "rt-1");
    expect(attempts).toEqual(["basic", "post", "post"]);
  });

  test("a provider that lists only client_secret_post gets that first", async () => {
    const { config, attempts } = provider({ accepts: ["post"], discovery: () => ({ token_endpoint_auth_methods_supported: ["client_secret_post"] }) });
    await signIn(config);
    expect(attempts).toEqual(["post"]);
  });

  test("wrong credentials still fail, after both ways were tried", async () => {
    const { config } = provider({});
    await expect(exchangeCode({ ...config, clientSecret: "nope" }, { code: "c", redirectUri: "https://app.test/cb", verifier: "v".repeat(43) })).rejects.toThrow();
  });

  test("a refresh without an ID token is a success", async () => {
    const { config } = provider({ refreshIdToken: false });
    const refreshed = await refresh(config, "rt-1");
    expect(refreshed.id_token).toBeUndefined();
    expect(refreshed.refresh_token).toBe("rt-2");
  });

  test("a revoked refresh token is an error", async () => {
    const { config } = provider({ refreshTokens: false });
    await expect(refresh(config, "rt-1")).rejects.toThrow("invalid_grant");
  });

  test("email_verified as the string \"true\" counts", async () => {
    const { config } = provider({ claims: { email: "a@b.test", email_verified: "true" } });
    expect(identityOf(config, (await signIn(config)).claims).emailVerified).toBe(true);
  });

  test("an email kept only at the userinfo endpoint is found there, for the same subject only", async () => {
    const { config } = provider({ claims: { name: "Jane" }, userinfo: { sub: "user-1", email: "jane@agency.test", email_verified: true } });
    const { claims } = await signIn(config);
    expect(identityOf(config, claims)).toEqual({ email: "jane@agency.test", emailVerified: true, name: "Jane" });

    clearDiscoveryCache();
    const other = provider({ userinfo: { sub: "someone-else", email: "eve@evil.test", email_verified: true } });
    expect(identityOf(other.config, (await signIn(other.config)).claims).email).toBeUndefined();
  });

  test("an issuer that ends with a slash verifies, however it was entered", async () => {
    const auth0 = provider({ issuer: root => `${root}/`, claims: { email: "a@b.test" } });
    for(const issuer of [auth0.issuer, `${auth0.issuer}/`, `${auth0.issuer}/.well-known/openid-configuration`]) {
      clearDiscoveryCache();
      expect((await signIn({ ...auth0.config, issuer })).claims.iss).toBe(`${auth0.issuer}/`);
    }
  });

  test("a name comes from the pieces when there's no name claim", () => {
    expect(identityOf({}, { given_name: "Jane", family_name: "Doe" }).name).toBe("Jane Doe");
    expect(identityOf({}, { preferred_username: "jdoe" }).name).toBe("jdoe");
  });

  test("scopes set in the config are used exactly", async () => {
    const { config } = provider({ discovery: () => ({ scopes_supported: ["openid", "offline_access"] }) });
    expect((await signIn({ ...config, scopes: "openid email" })).scope).toEqual(["openid", "email"]);
  });

  test("groups can come from a named claim, a namespaced one or a nested one", () => {
    const claims: JWTPayload = { "https://app.test/roles": ["Admin"], realm_access: { roles: ["ops"] }, groups: "staff" };
    expect(claimValues(claims, "https://app.test/roles")).toEqual(["Admin"]);
    expect(claimValues(claims, "realm_access.roles")).toEqual(["ops"]);
    expect(isAllowed("admin", claims, { rolesClaim: "https://app.test/roles" })).toBe(true);
    expect(isAllowed("ops", claims, { rolesClaim: "realm_access.roles" })).toBe(true);
    expect(isAllowed("staff", claims)).toBe(true);
    expect(isAllowed("nobody", claims)).toBe(false);
    expect(isAllowed("", claims)).toBe(true);
  });
});
