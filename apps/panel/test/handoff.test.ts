import { afterAll, beforeAll, expect, test } from "bun:test";
import { assignRoles, env, HUB, idp, idToken, installMock, ISSUER, jar, panel, removeMock, signIn, siteId, sites } from "./mock.ts";

beforeAll(installMock);
afterAll(removeMock);

test("sign-in, adding a site, and the one-time code handoff", async () => {
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  const a = await siteId("https://site-a.test");
  const callback = await signIn();
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("https://panel.test/s/site-a/");
  expect(await (await panel("/api/me")).json()).toEqual({ name: "Jane", email: "jane@agency.test", role: "owner", admin: true, permissions: ["members", "templates", "addSites", "removeSites"] });

  const added = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-a.test" }) });
  expect(added.status).toBe(201);
  const refused = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-b.test" }) });
  expect(refused.status).toBe(422);
  expect((await refused.json() as { error: string }).error).toBe("This site trusts another org (other.test), not agency.test");

  await panel(`/api/sites/${a}/favorite`, { method: "PUT" });
  expect(await (await panel("/api/sites")).json()).toEqual([
    { id: a, url: "https://site-a.test", name: "site-a.test", admin: "https://site-a.test/_vibe/admin", favorite: true }
  ]);

  const { code } = await (await panel(`/api/sites/${a}/code`, { method: "POST" })).json() as { code: string };
  expect(code).toBeTruthy();

  // The editor trades the code for a site session token, once.
  const siteA = sites["https://site-a.test"]!;
  const exchange = await siteA(new Request("https://site-a.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) }));
  const session = await exchange.json() as { token: string, user: { sub: string, roles: string[] } };
  // The hub's owner manages every site: the hub's signed siteAdmin claim makes her an owner there.
  expect(session.user).toMatchObject({ sub: `${ISSUER}|u-jane`, roles: ["owner"] });
  const me = await siteA(new Request("https://site-a.test/_vibe/api/session", { headers: { authorization: `Bearer ${session.token}` } }));
  expect(me.status).toBe(200);
  const replay = await siteA(new Request("https://site-a.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) }));
  expect(replay.status).toBe(401);

  // The site only takes sign-in tokens from its hub: a provider ID token is no good.
  const forged = await siteA(new Request("https://site-a.test/_vibe/api/session/code", { method: "POST", body: JSON.stringify({ token: await idToken() }) }));
  expect(forged.status).toBe(401);

  // There's no full-page handoff: editors only open inside the hub.
  expect((await panel(`/go/${a}`)).status).not.toBe(302);
});

test("hub tokens are addressed to one site and only work there", async () => {
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  await signIn();
  const a = await siteId("https://site-a.test");
  const { userToken } = await import("../src/server/hub.ts");
  const { currentSession } = await import("../src/server/shared.ts");
  const session = await currentSession(new Request(HUB, { headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } }), env);
  const token = await userToken(env, session!, a);
  const siteA = sites["https://site-a.test"]!;
  const me = await siteA(new Request("https://site-a.test/_vibe/api/session", { headers: { authorization: `Bearer ${token}` } }));
  expect(await me.json()).toMatchObject({ user: { sub: `${ISSUER}|u-jane`, email: "jane@agency.test", roles: ["owner"] } });
  // The same token on a site it wasn't addressed to: refused.
  const b = await siteId("https://site-b.test");
  const wrongSite = await userToken(env, session!, b);
  expect((await siteA(new Request("https://site-a.test/_vibe/api/session", { headers: { authorization: `Bearer ${wrongSite}` } }))).status).toBe(401);
});

test("people see only the sites they have a role on, with the roles the hub gave them", async () => {
  const a = await siteId("https://site-a.test");
  await assignRoles(a, "u-bob", []);
  idp.email = "bob@agency.test";
  idp.sub = "u-bob";
  await signIn();
  // Not a member and no role anywhere: no sites, and no way in.
  expect(await (await panel("/api/sites")).json()).toEqual([]);
  expect((await panel(`/api/sites/${a}/code`, { method: "POST" })).status).toBe(404);
  expect((await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-a.test" }) })).status).toBe(403);

  // A role the site doesn't have gives nothing there.
  await assignRoles(a, "u-bob", ["ghost"]);
  const refused = await panel(`/api/sites/${a}/code`, { method: "POST" });
  expect(refused.status).toBe(403);
  expect((await refused.json() as { error: string }).error).toBe("No access to this site");

  await assignRoles(a, "u-bob", ["editor", "owner"]);
  const { code } = await (await panel(`/api/sites/${a}/code`, { method: "POST" })).json() as { code: string };
  const exchange = await sites["https://site-a.test"]!(new Request("https://site-a.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) }));
  // A role claim naming "owner" still counts for nothing; only the signed siteAdmin claim does.
  expect((await exchange.json() as { user: { roles: string[] } }).user.roles).toEqual(["editor"]);
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
