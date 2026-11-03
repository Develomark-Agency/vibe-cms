import { afterAll, beforeAll, expect, test } from "bun:test";
import { idp, installMock, ISSUER, jar, panel, removeMock, signIn, siteId, sites } from "./mock.ts";

beforeAll(installMock);
afterAll(removeMock);

test("sign-in, adding a site, and the one-time code handoff", async () => {
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  const a = await siteId("https://site-a.test");
  const callback = await signIn();
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("https://panel.test/s/site-a/");
  expect(await (await panel("/api/me")).json()).toEqual({ name: "Jane", email: "jane@agency.test" });

  const added = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-a.test" }) });
  expect(added.status).toBe(201);
  const refused = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://site-b.test" }) });
  expect(refused.status).toBe(422);
  expect((await refused.json() as { error: string }).error).toBe("This site trusts a different identity provider");

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
  expect(session.user).toMatchObject({ sub: `${ISSUER}|u-jane`, roles: ["editor"] });
  const me = await siteA(new Request("https://site-a.test/_vibe/api/session", { headers: { authorization: `Bearer ${session.token}` } }));
  expect(me.status).toBe(200);
  const replay = await siteA(new Request("https://site-a.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) }));
  expect(replay.status).toBe(401);

  // Full-page mode: the code travels in the fragment.
  const go = await panel(`/go/${a}`);
  expect(go.headers.get("location")).toMatch(/^https:\/\/site-a\.test\/_vibe\/admin\/#code=.+/);
});

test("a site refuses users it gives no role", async () => {
  idp.email = "bob@agency.test";
  idp.sub = "u-bob";
  await signIn();
  const response = await panel(`/api/sites/${await siteId("https://site-a.test")}/code`, { method: "POST" });
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
