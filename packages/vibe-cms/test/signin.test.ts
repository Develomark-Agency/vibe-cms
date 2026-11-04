import { afterEach, describe, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { EmailMessage, EmailSender } from "../src/handler/email.ts";
import { createHandler } from "../src/handler/index.ts";
import { defineConfig } from "../src/index.ts";
import v from "../src/schema/index.ts";
import { createD1, ctx } from "./helpers.ts";
import { Authenticator } from "./webauthn.ts";

/** Sites without an org: the setup link, invites, passkeys, an identity provider of their own. */

const ORIGIN = "https://client.test";

const config = defineConfig({
  permissions: {
    roles: { editor: { post: ["read", "write"] } },
    users: { "config@client.test": ["editor"] }
  },
  schemas: { post: v.object({ title: v.text() }) }
});

function site(vars: Record<string, string> = {}, email?: EmailSender) {
  const env = { DB: createD1(), ...vars };
  const vibe = createHandler(config, { dev: false, bindings: (e: typeof env) => ({ db: e.DB, email }) });

  /** One browser: keeps the sign-in cookie, and the session token the editor holds in memory. */
  function browser() {
    const cookies = new Map<string, string>();
    let token = "";
    async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
      const headers = new Headers(init.headers);
      if(cookies.size) headers.set("cookie", [...cookies].map(([k, val]) => `${k}=${val}`).join("; "));
      if(token) headers.set("authorization", `Bearer ${token}`);
      if(init.json !== undefined) headers.set("content-type", "application/json");
      const response = await vibe.handle(new Request(`${ORIGIN}/_vibe${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env, ctx);
      for(const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const [name, value] = pair!.split("=");
        if(value) cookies.set(name!, value);
        else cookies.delete(name!);
      }
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as any : null };
    }
    return {
      call,
      cookies,
      /** What the editor does on load: trade the cookie for a session token. */
      async resume() {
        const response = await call("/api/session", { method: "POST", json: { resume: true } });
        token = response.body?.token ?? "";
        return response;
      }
    };
  }

  async function setupToken(): Promise<string> {
    // Prints the link to the logs, and keeps the token until it's used.
    await browser().call("/api/auth");
    const row = env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'setup_token'").get() as { value: string } | null;
    return row!.value;
  }

  return { env, browser, setupToken };
}

async function registerWith(browser: ReturnType<ReturnType<typeof site>["browser"]>, authenticator: Authenticator, input: Record<string, unknown>) {
  const options = await browser.call("/api/auth/passkey/register/options", { method: "POST", json: input });
  if(options.status !== 200) return options;
  const response = await authenticator.create(options.body.options);
  return browser.call("/api/auth/passkey/register", { method: "POST", json: { challengeId: options.body.challengeId, response } });
}

async function signInWith(browser: ReturnType<ReturnType<typeof site>["browser"]>, authenticator: Authenticator) {
  const options = await browser.call("/api/auth/passkey/login/options", { method: "POST", json: {} });
  const response = await authenticator.get(options.body.options);
  return browser.call("/api/auth/passkey/login", { method: "POST", json: { challengeId: options.body.challengeId, response } });
}

describe("passkeys", () => {
  test("the setup link makes the first owner, once", async () => {
    const s = site();
    const browser = s.browser();
    expect((await browser.call("/api/auth")).body).toEqual({ mode: "passkey", setup: true, email: false, provider: null });
    const token = await s.setupToken();

    const registered = await registerWith(browser, new Authenticator(ORIGIN), { setup: token, email: "Owner@Client.test", name: "Olive" });
    expect(registered.status).toBe(200);
    expect(browser.cookies.has("vibe_signin")).toBe(true);
    const session = await browser.resume();
    expect(session.body.user).toMatchObject({ sub: expect.stringMatching(/^vibe\|user_/), email: "owner@client.test", name: "Olive", roles: ["owner"] });
    expect(session.body.permissions).toMatchObject({ site: true, users: true });

    expect((await s.browser().call("/api/auth")).body.setup).toBe(false);
    const again = await registerWith(s.browser(), new Authenticator(ORIGIN), { setup: token, email: "eve@client.test" });
    expect(again.status).toBe(403);
  });

  test("owners invite people, who register a passkey with the link, then sign in with it", async () => {
    const s = site();
    const owner = s.browser();
    await registerWith(owner, new Authenticator(ORIGIN), { setup: await s.setupToken(), email: "owner@client.test" });
    await owner.resume();

    const invited = await owner.call("/api/users/invites", { method: "POST", json: { email: "bob@client.test", roles: ["editor"] } });
    expect(invited.status).toBe(201);
    expect(invited.body).toMatchObject({ emailed: false, emailError: null, user: { email: "bob@client.test", roles: ["editor"] } });
    const inviteToken = new URL(invited.body.link).hash.replace("#invite=", "");
    expect(invited.body.link).toStartWith(`${ORIGIN}/_vibe/admin/#invite=`);

    const bob = s.browser();
    const phone = new Authenticator(ORIGIN);
    expect((await registerWith(bob, phone, { invite: inviteToken })).status).toBe(200);
    expect((await bob.resume()).body.user).toMatchObject({ email: "bob@client.test", roles: ["editor"] });
    expect((await bob.call("/api/users")).status).toBe(403);
    // An invite works once.
    expect((await registerWith(s.browser(), new Authenticator(ORIGIN), { invite: inviteToken })).status).toBe(403);

    // Later, on another browser: sign in with the passkey alone.
    const later = s.browser();
    expect((await signInWith(later, phone)).status).toBe(200);
    expect((await later.resume()).body.user.email).toBe("bob@client.test");
    // A passkey the site never registered gets nowhere.
    const stranger = new Authenticator(ORIGIN);
    await stranger.create({ challenge: "x", user: { id: "x" } });
    expect((await signInWith(s.browser(), stranger)).status).toBe(401);

    // Changing roles applies at the next session; removing someone ends their sign-in.
    const users = (await owner.call("/api/users")).body.users as Array<{ id: string, email: string, passkeys: number }>;
    const bobRow = users.find(u => u.email === "bob@client.test")!;
    expect(bobRow.passkeys).toBe(1);
    expect((await owner.call(`/api/users/${bobRow.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await later.resume()).status).toBe(403);
  });

  test("the last owner can't be removed or demoted", async () => {
    const s = site();
    const owner = s.browser();
    await registerWith(owner, new Authenticator(ORIGIN), { setup: await s.setupToken(), email: "owner@client.test" });
    await owner.resume();
    const [me] = (await owner.call("/api/users")).body.users;
    expect((await owner.call(`/api/users/${me.id}`, { method: "DELETE" })).status).toBe(409);
    expect((await owner.call(`/api/users/${me.id}`, { method: "PATCH", json: { roles: ["editor"] } })).status).toBe(409);
    expect((await owner.call(`/api/users/${me.id}`, { method: "PATCH", json: { roles: ["nope"] } })).status).toBe(400);
  });

  test("invites are emailed when the site has a sender, and still shown when sending fails", async () => {
    const sent: EmailMessage[] = [];
    let fail = false;
    const s = site({}, {
      async send(message) {
        if(fail) throw new Error("Quota exceeded");
        sent.push(message);
      }
    });
    const owner = s.browser();
    await registerWith(owner, new Authenticator(ORIGIN), { setup: await s.setupToken(), email: "owner@client.test", name: "Olive" });
    await owner.resume();
    expect((await owner.call("/api/auth")).body.email).toBe(true);

    const invited = await owner.call("/api/users/invites", { method: "POST", json: { email: "bob@client.test", roles: ["editor"] } });
    expect(invited.body.emailed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "bob@client.test", subject: "You're invited to edit client.test" });
    expect(sent[0]!.text).toContain(invited.body.link);
    expect(sent[0]!.text).toContain("Olive invited you");

    fail = true;
    const failed = await owner.call("/api/users/invites", { method: "POST", json: { email: "carol@client.test", roles: ["editor"] } });
    expect(failed.body).toMatchObject({ emailed: false, emailError: "Quota exceeded", link: expect.stringContaining("#invite=") });
  });

  test("signing out ends the browser's sign-in", async () => {
    const s = site();
    const owner = s.browser();
    await registerWith(owner, new Authenticator(ORIGIN), { setup: await s.setupToken(), email: "owner@client.test" });
    const cookie = owner.cookies.get("vibe_signin")!;
    await owner.call("/api/session", { method: "DELETE" });
    expect(owner.cookies.has("vibe_signin")).toBe(false);
    owner.cookies.set("vibe_signin", cookie);
    expect((await owner.resume()).status).toBe(401);
  });

  test("the cookie only buys a session from the site's own pages", async () => {
    const s = site();
    const owner = s.browser();
    await registerWith(owner, new Authenticator(ORIGIN), { setup: await s.setupToken(), email: "owner@client.test" });
    const response = await owner.call("/api/session", { method: "POST", json: { resume: true }, headers: { origin: "https://evil.test" } });
    expect(response.status).toBe(403);
    // And it isn't a credential anywhere else.
    expect((await owner.call("/api/documents/post")).status).toBe(401);
  });

  test("a site in an org signs in through its hub only", async () => {
    const s = site({ VIBE_ORG: "https://hub.test" });
    const browser = s.browser();
    expect((await browser.call("/api/auth")).body).toMatchObject({ mode: "hub", setup: false });
    expect((await browser.call("/api/auth/passkey/login/options", { method: "POST", json: {} })).status).toBe(409);
  });
});

describe("the site's own identity provider", () => {
  const ISSUER = "https://idp.test";
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // One key for the provider throughout: sites cache its keys by issuer.
  const keys = generateKeyPair("RS256");

  async function provider(claims: Record<string, unknown>) {
    const { privateKey, publicKey } = await keys;
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    let nonce = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if(url.pathname === "/.well-known/openid-configuration") {
        return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
      }
      if(url.pathname === "/jwks") return Response.json({ keys: [jwk] });
      if(url.pathname === "/token") {
        const idToken = await new SignJWT({ nonce, ...claims })
          .setProtectedHeader({ alg: "RS256", kid: "k1" })
          .setIssuer(ISSUER).setAudience("site-client").setSubject("u-1").setIssuedAt().setExpirationTime("1h")
          .sign(privateKey);
        return Response.json({ id_token: idToken });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    return { setNonce: (value: string) => (nonce = value) };
  }

  const OIDC = { OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: "site-client", OIDC_CLIENT_SECRET: "secret" };

  async function login(s: ReturnType<typeof site>, idp: { setNonce(n: string): void }, browser: ReturnType<ReturnType<typeof site>["browser"]>, query = "") {
    const start = await browser.call(`/api/auth/oidc/login${query}`);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.get("location")!);
    expect(authorize.origin).toBe(ISSUER);
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/_vibe/api/auth/oidc/callback`);
    idp.setNonce(authorize.searchParams.get("nonce")!);
    return browser.call(`/api/auth/oidc/callback?code=c&state=${authorize.searchParams.get("state")}`);
  }

  test("the setup link makes whoever signs in with it the owner", async () => {
    const idp = await provider({ email: "owner@client.test", email_verified: true, name: "Olive" });
    const s = site(OIDC);
    const browser = s.browser();
    expect((await browser.call("/api/auth")).body).toEqual({ mode: "oidc", setup: true, email: false, provider: "idp.test" });
    const token = await s.setupToken();
    const done = await login(s, idp, browser, `?setup=${token}`);
    expect(done.headers.get("location")).toBe(`${ORIGIN}/_vibe/admin/`);
    expect((await browser.resume()).body.user).toMatchObject({ sub: `${ISSUER}|u-1`, email: "owner@client.test", roles: ["owner"] });
    expect((await browser.call("/api/auth")).body.setup).toBe(false);
  });

  test("people sign in with roles from the config, invites and the role claim; others are turned away", async () => {
    const idp = await provider({ email: "config@client.test", email_verified: true });
    const s = site(OIDC);
    const browser = s.browser();
    await login(s, idp, browser);
    expect((await browser.resume()).body.user).toMatchObject({ email: "config@client.test", roles: ["editor"] });

    const stranger = await provider({ email: "eve@elsewhere.test", email_verified: true });
    const eve = s.browser();
    const refused = await login(s, stranger, eve);
    expect(decodeURIComponent(refused.headers.get("location")!)).toContain("#error=No access to this site");
    expect(eve.cookies.has("vibe_signin")).toBe(false);

    const grouped = await provider({ email: "gil@client.test", email_verified: true, groups: ["editor", "owner"] });
    const siteWithClaim = site({ ...OIDC, OIDC_ROLES_CLAIM: "groups" });
    const gil = siteWithClaim.browser();
    await login(siteWithClaim, grouped, gil);
    // "owner" only comes from the site itself, never from a provider group of that name.
    expect((await gil.resume()).body.user.roles).toEqual(["editor"]);
  });

  test("VIBE_ALLOW keeps other accounts out before roles are looked at", async () => {
    const idp = await provider({ email: "config@client.test", email_verified: true });
    const s = site({ ...OIDC, VIBE_ALLOW: "agency.test" });
    const browser = s.browser();
    const refused = await login(s, idp, browser);
    expect(decodeURIComponent(refused.headers.get("location")!)).toContain("isn't allowed to sign in");
  });

  test("a callback without the login cookie is refused", async () => {
    const idp = await provider({ email: "config@client.test", email_verified: true });
    const s = site(OIDC);
    const browser = s.browser();
    const start = await browser.call("/api/auth/oidc/login");
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    idp.setNonce(new URL(start.headers.get("location")!).searchParams.get("nonce")!);
    const other = s.browser();
    const callback = await other.call(`/api/auth/oidc/callback?code=c&state=${state}`);
    expect(decodeURIComponent(callback.headers.get("location")!)).toContain("Sign-in expired");
  });

  test("half an identity provider config is an error, not passkeys", async () => {
    const s = site({ OIDC_ISSUER: ISSUER });
    expect(s.browser().call("/api/auth")).rejects.toThrow("needs all of OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET");
  });
});
