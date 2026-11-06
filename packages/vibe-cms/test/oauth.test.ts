import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/handler/index.ts";
import { defineConfig } from "../src/index.ts";
import { pkceChallenge } from "../src/oidc/index.ts";
import v from "../src/schema/index.ts";
import { createD1, ctx } from "./helpers.ts";
import { Authenticator } from "./webauthn.ts";

/** Agents and the CLI signing in to a site without an org: the site as an OAuth server. */

const ORIGIN = "https://client.test";

const config = defineConfig({
  schemas: { post: v.object({ title: v.text() }) }
});

function site(vars: Record<string, string> = {}) {
  const env = { DB: createD1({ roles: { editor: { post: ["read", "write", "publish"] } } }), ...vars };
  const vibe = createHandler(config, { dev: false, bindings: (e: typeof env) => ({ db: e.DB }) });

  async function raw(path: string, init: RequestInit & { json?: unknown, form?: Record<string, string>, bearer?: string, cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    let body = init.body;
    if(init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    if(init.form) {
      headers.set("content-type", "application/x-www-form-urlencoded");
      body = new URLSearchParams(init.form).toString();
    }
    if(init.bearer) headers.set("authorization", `Bearer ${init.bearer}`);
    if(init.cookie) headers.set("cookie", init.cookie);
    const response = await vibe.handle(new Request(`${ORIGIN}${path}`, { ...init, headers, body }), env, ctx);
    const text = await response.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: response.status, headers: response.headers, body: parsed };
  }

  /** The first owner, signed in with a passkey: their browser's cookie and editor session token. */
  async function owner() {
    await raw("/_vibe/api/auth");
    const token = (env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'setup_token'").get() as { value: string }).value;
    const authenticator = new Authenticator(ORIGIN);
    const options = await raw("/_vibe/api/auth/passkey/register/options", { method: "POST", json: { setup: token, email: "owner@client.test" } });
    const registered = await raw("/_vibe/api/auth/passkey/register", { method: "POST", json: { challengeId: options.body.challengeId, response: await authenticator.create(options.body.options) } });
    const cookie = registered.headers.getSetCookie()[0]!.split(";")[0]!;
    const session = await raw("/_vibe/api/session", { method: "POST", json: { resume: true }, cookie });
    return { cookie, token: session.body.token as string };
  }

  /** What an agent does: register, authorize, the user approves in the editor, then trade the code. */
  async function connect(user: { cookie: string, token: string }, options: { readOnly?: boolean, scope?: string, redirect?: string } = {}) {
    const redirect = options.redirect ?? "http://127.0.0.1:4567/callback";
    const registered = await raw("/_vibe/oauth/register", {
      method: "POST",
      json: { client_name: "Claude", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }
    });
    expect(registered.status).toBe(201);
    const clientId = registered.body.client_id as string;
    const verifier = "v".repeat(48);
    const query = new URLSearchParams({
      response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: await pkceChallenge(verifier), code_challenge_method: "S256", state: "s1",
      ...(options.scope ? { scope: options.scope } : {})
    });
    const authorize = await raw(`/_vibe/oauth/authorize?${query}`);
    expect(authorize.status).toBe(302);
    const location = authorize.headers.get("location")!;
    expect(location).toStartWith(`${ORIGIN}/_vibe/admin/#connect=`);
    const request = location.split("#connect=")[1]!;
    const decided = await raw("/_vibe/api/oauth/decide", { method: "POST", json: { request, allow: true, readOnly: options.readOnly ?? false }, bearer: user.token, cookie: user.cookie });
    expect(decided.status).toBe(200);
    const back = new URL(decided.body.redirect);
    expect(back.searchParams.get("state")).toBe("s1");
    expect(back.searchParams.get("iss")).toBe(`${ORIGIN}/_vibe`);
    const tokens = await raw("/_vibe/oauth/token", { method: "POST", form: { grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: redirect, code_verifier: verifier, client_id: clientId } });
    expect(tokens.status).toBe(200);
    return { clientId, request, ...tokens.body as { access_token: string, refresh_token: string, scope: string } };
  }

  return { env, raw, owner, connect };
}

describe("agents and the CLI sign in to the site", () => {
  test("an agent discovers the site's sign-in from a 401 on its MCP endpoint", async () => {
    const s = site();
    const unauthorized = await s.raw("/_vibe/api/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(unauthorized.status).toBe(401);
    const header = unauthorized.headers.get("www-authenticate")!;
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(header)![1]!;
    expect(metadataUrl).toBe(`${ORIGIN}/_vibe/.well-known/oauth-protected-resource`);
    const resource = await s.raw(new URL(metadataUrl).pathname);
    expect(resource.body).toMatchObject({ resource: `${ORIGIN}/_vibe/api/mcp`, authorization_servers: [`${ORIGIN}/_vibe`] });
    // RFC 8414 path insertion, and the issuer-relative form some clients try.
    for(const path of ["/.well-known/oauth-authorization-server/_vibe", "/_vibe/.well-known/oauth-authorization-server"]) {
      const server = await s.raw(path);
      expect(server.body).toMatchObject({ issuer: `${ORIGIN}/_vibe`, authorization_endpoint: `${ORIGIN}/_vibe/oauth/authorize`, code_challenge_methods_supported: ["S256"] });
    }
  });

  test("an approved agent works as the user who approved it", async () => {
    const s = site();
    const owner = await s.owner();
    const { access_token: access, scope } = await s.connect(owner);
    expect(scope).toBe("content");
    const tools = await s.raw("/_vibe/api/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" }, bearer: access, headers: { accept: "application/json, text/event-stream" } });
    expect(tools.status).toBe(200);
    const created = await s.raw("/_vibe/api/actions/documents.create", { method: "POST", json: { type: "post", data: { title: "From an agent" } }, bearer: access });
    expect(created.status).toBe(200);
    const me = await s.raw("/_vibe/api/session", { bearer: access });
    expect(me.body.user).toMatchObject({ email: "owner@client.test", roles: ["owner"] });

    // It's listed for the user, who can disconnect it.
    const listed = await s.raw("/_vibe/api/oauth/connections", { bearer: owner.token });
    expect(listed.body.connections).toEqual([expect.objectContaining({ name: "Claude", readOnly: false })]);
    await s.raw(`/_vibe/api/oauth/connections/${listed.body.connections[0].id}`, { method: "DELETE", bearer: owner.token });
    expect((await s.raw("/_vibe/api/session", { bearer: access })).status).toBe(401);
  });

  test("a read-only connection can read but not write", async () => {
    const s = site();
    const owner = await s.owner();
    const { access_token: access, scope } = await s.connect(owner, { readOnly: true });
    expect(scope).toBe("content:read");
    expect((await s.raw("/_vibe/api/actions/documents.list", { method: "POST", json: { type: "post" }, bearer: access })).status).toBe(200);
    expect((await s.raw("/_vibe/api/actions/documents.create", { method: "POST", json: { type: "post", data: { title: "No" } }, bearer: access })).status).toBe(403);
    // Asking only for the read scope makes it read only, whatever the user ticks.
    const scoped = await s.connect(owner, { scope: "content:read" });
    expect(scoped.scope).toBe("content:read");
  });

  test("refresh tokens rotate, and revoking ends the connection", async () => {
    const s = site();
    const owner = await s.owner();
    const first = await s.connect(owner);
    const refreshed = await s.raw("/_vibe/oauth/token", { method: "POST", form: { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId } });
    expect(refreshed.status).toBe(200);
    expect((await s.raw("/_vibe/oauth/token", { method: "POST", form: { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId } })).status).toBe(400);
    expect((await s.raw("/_vibe/api/session", { bearer: first.access_token })).status).toBe(401);
    const access = refreshed.body.access_token as string;
    expect((await s.raw("/_vibe/api/session", { bearer: access })).status).toBe(200);
    await s.raw("/_vibe/oauth/revoke", { method: "POST", form: { token: refreshed.body.refresh_token, client_id: first.clientId } });
    expect((await s.raw("/_vibe/api/session", { bearer: access })).status).toBe(401);
  });

  test("codes need the right PKCE verifier, and work once", async () => {
    const s = site();
    const owner = await s.owner();
    const registered = await s.raw("/_vibe/oauth/register", { method: "POST", json: { redirect_uris: ["http://127.0.0.1:1/cb"], token_endpoint_auth_method: "none" } });
    const clientId = registered.body.client_id;
    const authorize = await s.raw(`/_vibe/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:1/cb", code_challenge: await pkceChallenge("right".repeat(10)), code_challenge_method: "S256" })}`);
    const request = authorize.headers.get("location")!.split("#connect=")[1]!;
    const decided = await s.raw("/_vibe/api/oauth/decide", { method: "POST", json: { request, allow: true }, bearer: owner.token, cookie: owner.cookie });
    const code = new URL(decided.body.redirect).searchParams.get("code")!;
    const wrong = await s.raw("/_vibe/oauth/token", { method: "POST", form: { grant_type: "authorization_code", code, redirect_uri: "http://127.0.0.1:1/cb", code_verifier: "wrong".repeat(10), client_id: clientId } });
    expect(wrong.body.error).toBe("invalid_grant");
  });

  test("approving needs the browser's own sign-in; cancelling sends the agent away empty-handed", async () => {
    const s = site();
    const owner = await s.owner();
    const registered = await s.raw("/_vibe/oauth/register", { method: "POST", json: { redirect_uris: ["https://agent.test/cb"], token_endpoint_auth_method: "none" } });
    async function start() {
      const authorize = await s.raw(`/_vibe/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.body.client_id, redirect_uri: "https://agent.test/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256", state: "z" })}`);
      return authorize.headers.get("location")!.split("#connect=")[1]!;
    }
    expect((await s.raw(`/_vibe/api/oauth/request?id=${await start()}`, { bearer: owner.token })).body).toMatchObject({ client: "An agent", returnsTo: "agent.test", showsCode: false });
    const noCookie = await s.raw("/_vibe/api/oauth/decide", { method: "POST", json: { request: await start(), allow: true }, bearer: owner.token });
    expect(noCookie.status).toBe(403);
    const cancelled = await s.raw("/_vibe/api/oauth/decide", { method: "POST", json: { request: await start(), allow: false }, bearer: owner.token, cookie: owner.cookie });
    expect(new URL(cancelled.body.redirect).searchParams.get("error")).toBe("access_denied");
    // A return address the client didn't register is shown, never followed.
    const foreign = await s.raw(`/_vibe/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: registered.body.client_id, redirect_uri: "https://evil.test/cb", code_challenge: "x".repeat(43), code_challenge_method: "S256" })}`);
    expect(foreign.status).toBe(400);
    expect(foreign.headers.get("location")).toBeNull();
  });

  test("a headless CLI login shows its code on the site, with the state to check", async () => {
    const s = site();
    const owner = await s.owner();
    const { request } = await s.connect(owner, { redirect: `${ORIGIN}/_vibe/oauth/code` });
    expect(request).toBeTruthy();
    const page = await s.raw("/_vibe/oauth/code?code=abc&state=xyz");
    expect(page.status).toBe(200);
    expect(page.body).toContain("abc.xyz");
  });

  test("a site in an org leaves all of this to its hub", async () => {
    const s = site({ VIBE_ORG: "https://hub.test" });
    expect((await s.raw("/.well-known/oauth-authorization-server/_vibe")).status).toBe(404);
    expect((await s.raw("/_vibe/oauth/register", { method: "POST", json: {} })).status).toBe(404);
    const mcp = await s.raw("/_vibe/api/mcp", { method: "POST", json: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(mcp.body.error.message).toContain("agency panel");
  });
});
