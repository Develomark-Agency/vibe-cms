import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { handle } from "../src/server/index.ts";
import { pkceChallenge, randomString } from "../src/server/oidc.ts";
import { assignRoles, env, idp, installMock, ISSUER, panel, removeMock, signIn, site, siteId, sites } from "./mock.ts";

beforeAll(installMock);
afterAll(removeMock);

const REDIRECT = "https://agent.test/callback";
let a: string;

beforeEach(async () => {
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  await signIn();
  await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-a.test" }) });
  a = await siteId("https://site-a.test");
});

async function registerAgent(method = "none") {
  const response = await panel("/oauth/register", {
    method: "POST",
    body: JSON.stringify({ client_name: "Test agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: method })
  });
  expect(response.status).toBe(201);
  return await response.json() as { client_id: string, client_secret?: string };
}

function form(values: Record<string, string>, headers: Record<string, string> = {}): RequestInit {
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(values).toString() };
}

/** The whole dance an MCP client does: authorize, consent, provider sign-in, code for tokens. */
async function connect(options: { readOnly?: boolean, decision?: string, client?: { client_id: string, client_secret?: string } } = {}) {
  const client = options.client ?? await registerAgent();
  const verifier = randomString(48);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "agent-state",
    resource: "https://panel.test/mcp"
  });
  const consent = await panel(`/oauth/authorize?${params}`);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("Test agent");
  const request = /name="request" value="([^"]+)"/.exec(html)![1]!;

  const decided = await panel("/oauth/authorize", form(
    { request, decision: options.decision ?? "allow", ...(options.readOnly ? { readonly: "on" } : {}) },
    { origin: "https://panel.test" }
  ));
  const next = new URL(decided.headers.get("location")!);
  if(next.origin !== ISSUER) return { client, verifier, redirect: next };
  expect(next.searchParams.get("login_hint")).toBe(idp.email);
  idp.nonce = next.searchParams.get("nonce")!;
  const callback = await panel(`/auth/callback?code=good-code&state=${next.searchParams.get("state")}`);
  const redirect = new URL(callback.headers.get("location")!);
  return { client, verifier, redirect };
}

async function tokens(values: Record<string, string>, headers: Record<string, string> = {}) {
  const response = await panel("/oauth/token", form(values, headers));
  return { status: response.status, body: await response.json() as { access_token: string, refresh_token: string, scope: string, error?: string } };
}

async function connectWithTokens(options: { readOnly?: boolean } = {}) {
  const { client, verifier, redirect } = await connect(options);
  expect(redirect.origin + redirect.pathname).toBe(REDIRECT);
  expect(redirect.searchParams.get("state")).toBe("agent-state");
  expect(redirect.searchParams.get("iss")).toBe("https://panel.test");
  const { body } = await tokens({ grant_type: "authorization_code", code: redirect.searchParams.get("code")!, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
  return { client, ...body };
}

let id = 0;
async function mcp(token: string | null, method: string, params: Record<string, unknown> = {}) {
  const response = await handle(new Request("https://panel.test/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
  }), env);
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) as any };
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  return (await mcp(token, "tools/call", { name, arguments: args })).body.result;
}

describe("discovery", () => {
  test("an agent without a token is told where to sign in", async () => {
    const response = await mcp(null, "tools/list");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer resource_metadata=\"https://panel.test/.well-known/oauth-protected-resource\"");
    const resource = await (await panel("/.well-known/oauth-protected-resource")).json() as Record<string, unknown>;
    expect(resource).toMatchObject({ resource: "https://panel.test/mcp", authorization_servers: ["https://panel.test"] });
    const server = await (await panel("/.well-known/oauth-authorization-server")).json() as Record<string, unknown>;
    expect(server).toMatchObject({
      issuer: "https://panel.test",
      authorization_endpoint: "https://panel.test/oauth/authorize",
      token_endpoint: "https://panel.test/oauth/token",
      registration_endpoint: "https://panel.test/oauth/register",
      code_challenge_methods_supported: ["S256"]
    });
    expect((await mcp("vpa_nope", "tools/list")).headers.get("www-authenticate")).toContain("error=\"invalid_token\"");
  });
});

describe("connecting an agent", () => {
  test("the agent works on the user's sites with the user's permissions", async () => {
    const { access_token: token, scope } = await connectWithTokens();
    expect(scope).toBe("content");

    const init = await mcp(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(init.body.result.instructions).toContain("sites_list");
    const { tools } = (await mcp(token, "tools/list")).body.result;
    const create = tools.find((t: { name: string }) => t.name === "documents_create");
    expect(create.inputSchema.required).toEqual(["site", "type", "data"]);

    expect((await call(token, "sites_list")).structuredContent.sites).toEqual([{ id: a, name: "site-a.test", url: "https://site-a.test" }]);
    const created = await call(token, "documents_create", { site: a, type: "post", data: { title: "From an agent" } });
    expect(created.isError).toBeUndefined();
    const doc = await call(token, "documents_get", { site: a, type: "post", id: created.structuredContent.id });
    expect(doc.structuredContent.draft).toEqual({ title: "From an agent" });
    // Recorded against the user, as if they'd edited it themselves.
    expect(doc.structuredContent.updatedBy).toBe(`${ISSUER}|u-jane`);

    expect((await call(token, "documents_list", { site: "nope", type: "post" })).content[0].text).toStartWith("[NOT_FOUND]");
  });

  test("signing out of the panel leaves the agent connected; disconnecting it doesn't sign anyone out", async () => {
    const { access_token: token } = await connectWithTokens();
    await panel("/auth/logout", { method: "POST" });
    expect((await call(token, "documents_list", { site: a, type: "post" })).isError).toBeUndefined();

    await signIn();
    const { mcpUrl, agents } = await (await panel("/api/agents")).json() as { mcpUrl: string, agents: Array<{ id: string, name: string, readOnly: boolean }> };
    expect(mcpUrl).toBe("https://panel.test/mcp");
    const agent = agents.find(a => a.name === "Test agent")!;
    expect((await panel(`/api/agents/${agent.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await mcp(token, "tools/list")).status).toBe(401);
    expect((await panel("/api/me")).status).toBe(200);
  });

  test("read-only connections only get tools that read", async () => {
    const { access_token: token, scope } = await connectWithTokens({ readOnly: true });
    expect(scope).toBe("content:read");
    const { tools } = (await mcp(token, "tools/list")).body.result;
    expect(tools.every((t: { annotations: { readOnlyHint: boolean } }) => t.annotations.readOnlyHint)).toBe(true);
    expect(tools.map((t: { name: string }) => t.name)).toContain("documents_list");
    const refused = await call(token, "documents_create", { site: a, type: "post", data: { title: "No" } });
    expect(refused.content[0].text).toStartWith("[FORBIDDEN]");
  });

  test("an agent only sees the user's sites, and the site's own rules apply", async () => {
    idp.email = "bob@agency.test";
    idp.sub = "u-bob";
    await signIn();
    const { access_token: token } = await connectWithTokens();
    expect((await call(token, "sites_list")).structuredContent.sites).toEqual([]);
    expect((await call(token, "documents_list", { site: a, type: "post" })).content[0].text).toStartWith("[NOT_FOUND]");

    await assignRoles(a, "u-bob", ["ghost"]);
    expect((await call(token, "documents_list", { site: a, type: "post" })).content[0].text).toBe("[FORBIDDEN] No access to this site");

    // Editors there can't touch site settings.
    await assignRoles(a, "u-bob", ["editor"]);
    expect((await call(token, "documents_list", { site: a, type: "post" })).isError).toBeUndefined();
    expect((await call(token, "site_update", { site: a, name: "Renamed" })).content[0].text).toStartWith("[FORBIDDEN]");
    idp.email = "jane@agency.test";
    idp.sub = "u-jane";
  });

  test("refresh tokens rotate", async () => {
    const { client, access_token: first, refresh_token: refresh } = await connectWithTokens();
    const renewed = await tokens({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id });
    expect(renewed.status).toBe(200);
    expect(renewed.body.access_token).not.toBe(first);
    expect((await mcp(first, "tools/list")).status).toBe(401);
    expect((await mcp(renewed.body.access_token, "tools/list")).status).toBe(200);
    expect((await tokens({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id })).body.error).toBe("invalid_grant");
  });

  test("confidential clients authenticate with their secret", async () => {
    const client = await registerAgent("client_secret_basic");
    expect(client.client_secret).toStartWith("vps_");
    const { verifier, redirect } = await connect({ client });
    const code = redirect.searchParams.get("code")!;
    function basic(secret: string) {
      return { authorization: `Basic ${btoa(`${client.client_id}:${secret}`)}` };
    }
    const values = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier };
    expect((await tokens(values, basic("wrong"))).status).toBe(401);
    expect((await tokens(values, basic(client.client_secret!))).body.access_token).toStartWith("vpa_");
  });
});

describe("refusals", () => {
  test("codes need the right PKCE verifier and work once", async () => {
    const { client, verifier, redirect } = await connect();
    const code = redirect.searchParams.get("code")!;
    const wrong = await tokens({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: "nope" });
    expect(wrong.body.error).toBe("invalid_grant");
    // The failed attempt used the code up.
    const retry = await tokens({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client.client_id, code_verifier: verifier });
    expect(retry.body.error).toBe("invalid_grant");
  });

  test("unregistered return addresses are never redirected to", async () => {
    const client = await registerAgent();
    const response = await panel(`/oauth/authorize?response_type=code&client_id=${client.client_id}&redirect_uri=${encodeURIComponent("https://evil.test/cb")}&code_challenge=x&code_challenge_method=S256`);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    const bad = await panel("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) });
    expect(bad.status).toBe(400);
  });

  test("cancelling sends the agent access_denied", async () => {
    const { redirect } = await connect({ decision: "deny" });
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("agent-state");
  });

  test("the consent form only accepts posts from the panel", async () => {
    const client = await registerAgent();
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "x", code_challenge_method: "S256" });
    const request = /name="request" value="([^"]+)"/.exec(await (await panel(`/oauth/authorize?${params}`)).text())![1]!;
    const forged = await panel("/oauth/authorize", form({ request, decision: "allow" }, { origin: "https://evil.test" }));
    expect(forged.status).toBe(403);
  });

  test("signed-out users sign in first and come back to the consent page", async () => {
    const client = await registerAgent();
    await panel("/auth/logout", { method: "POST" });
    const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "x", code_challenge_method: "S256" });
    const response = await panel(`/oauth/authorize?${params}`);
    expect(response.headers.get("location")).toBe(`https://panel.test/auth/login?return=${encodeURIComponent(`/oauth/authorize?${params}`)}`);
  });
});

describe("the CLI: site tokens and revocation", () => {
  async function siteTokenFor(token: string, site: string) {
    const response = await panel("/site-token", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ site }) });
    return { status: response.status, body: await response.json() as { token?: string, error?: string } };
  }

  test("a connection gets a session on a site by URL or id, which the site accepts", async () => {
    const { access_token: token } = await connectWithTokens();
    for(const site of ["https://site-a.test", "https://site-a.test/some/page", a]) {
      const { status, body } = await siteTokenFor(token, site);
      expect(status).toBe(200);
      const me = await fetch("https://site-a.test/_vibe/api/session", { headers: { authorization: `Bearer ${body.token}` } });
      expect(await me.json()).toMatchObject({ user: { sub: `${ISSUER}|u-jane`, roles: ["owner"] } });
    }
    expect((await siteTokenFor(token, "https://not-in-panel.test")).status).toBe(404);
    expect((await siteTokenFor("vpa_nope", a)).status).toBe(401);
  });

  test("read-only connections can't get site tokens", async () => {
    const { access_token: token } = await connectWithTokens({ readOnly: true });
    expect((await siteTokenFor(token, a)).status).toBe(403);
  });

  test("revoking the refresh token ends the whole connection", async () => {
    const { client, access_token: token, refresh_token: refresh } = await connectWithTokens();
    const revoked = await panel("/oauth/revoke", form({ token: refresh, client_id: client.client_id }));
    expect(revoked.status).toBe(200);
    expect((await siteTokenFor(token, a)).status).toBe(401);
    expect((await tokens({ grant_type: "refresh_token", refresh_token: refresh, client_id: client.client_id })).status).toBe(400);
    // Unknown tokens get the same answer, so revocation can't probe for valid ones.
    expect((await panel("/oauth/revoke", form({ token: "vpr_nope", client_id: client.client_id }))).status).toBe(200);
  });
});

describe("attaching a site", () => {
  let n = 0;

  // Leave the shared panel as it was: other files list its sites.
  afterAll(async () => {
    await (env.DB as unknown as { prepare(sql: string): { run(): Promise<unknown> } }).prepare("DELETE FROM sites WHERE url LIKE 'https://agent-claim-%'").run();
  });

  /** A site deployed without an org, and the claim link it logs. */
  async function unclaimed() {
    const origin = `https://agent-claim-${++n}.test`;
    sites[origin] = site("");
    const lines: string[] = [];
    const log = console.log;
    console.log = (...args: unknown[]) => void lines.push(args.join(" "));
    try {
      await sites[origin]!(new Request(`${origin}/_vibe/api/info`));
      await new Promise(resolve => setTimeout(resolve, 30));
    } finally {
      console.log = log;
    }
    return { origin, link: lines.join("\n").match(/(https:\/\/\S+#claim=\S+)/)![1]! };
  }

  test("an agent attaches a site from its claim link, with the user's permission to add sites", async () => {
    const { access_token: token } = await connectWithTokens();
    const { tools } = (await mcp(token, "tools/list")).body.result;
    expect(tools.find((t: { name: string }) => t.name === "sites_attach").inputSchema.required).toEqual(["link"]);

    const { origin, link } = await unclaimed();
    const attached = await call(token, "sites_attach", { link });
    expect(attached.isError).toBeUndefined();
    expect(attached.structuredContent.site).toMatchObject({ url: origin });
    expect((await call(token, "sites_list")).structuredContent.sites.map((s: { url: string }) => s.url)).toContain(origin);

    const other = await unclaimed();
    const bad = await call(token, "sites_attach", { link: `${other.origin}/_vibe/admin/#claim=nope` });
    expect(bad.isError).toBe(true);
    expect((await call(token, "sites_attach", {})).isError).toBe(true);
  });

  test("a read-only agent can't attach, and doesn't see the tool", async () => {
    const { access_token: token } = await connectWithTokens({ readOnly: true });
    expect((await mcp(token, "tools/list")).body.result.tools.map((t: { name: string }) => t.name)).not.toContain("sites_attach");
    const { link } = await unclaimed();
    expect((await call(token, "sites_attach", { link })).isError).toBe(true);
  });

  test("the CLI's route attaches with an access token, and refuses read-only ones", async () => {
    function post(token: string, body: unknown) {
      return panel("/site-attach", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    const { link, origin } = await unclaimed();
    expect((await post("vpa_nope", { link })).status).toBe(401);

    const readOnly = await connectWithTokens({ readOnly: true });
    expect((await post(readOnly.access_token, { link })).status).toBe(403);

    const { access_token: token } = await connectWithTokens();
    expect((await post(token, {})).status).toBe(400);
    const response = await post(token, { link });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ url: origin });
  });
});
