import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineConfig } from "vibe-cms";
import { createHandler } from "vibe-cms/handler";
import v from "vibe-cms/schema";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { env, idp, installMock, ISSUER, jar, ORG, panel, removeMock, setupToken, signIn, sites } from "./mock.ts";

/** A site with no roles of its own yet: what templates are for. */
function bareSite(origin: string) {
  const config = defineConfig({ locales: ["en", "fr"], schemas: { post: v.object({ title: v.text() }), page: v.object({ title: v.text() }) } });
  const vibe = createHandler(config, { dev: false, bindings: (e: { DB: ReturnType<typeof createD1> }) => ({ db: e.DB }) });
  const siteEnv = { DB: createD1(), VIBE_ORG: ORG };
  sites[origin] = request => vibe.handle(request, siteEnv, { waitUntil() {} });
}

function as(email: string, sub: string) {
  idp.email = email;
  idp.sub = sub;
  return signIn();
}

async function json<T = any>(response: Response | Promise<Response>): Promise<T> {
  return (await response).json() as Promise<T>;
}

// A hub of its own, so other files' sites and members don't show up here.
const shared = env.DB;
beforeAll(() => {
  installMock();
  env.DB = createD1() as unknown as D1Database;
});
afterAll(async () => {
  env.DB = shared;
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  removeMock();
});

describe("bootstrap", () => {
  test("nobody signs in until the setup link claims the hub, and it works once", async () => {
    const outer = env.DB;
    env.DB = createD1() as unknown as D1Database;
    try {
      expect(await json(panel("/api/setup"))).toEqual({ needsOwner: true });
      idp.email = "jane@agency.test";
      idp.sub = "u-jane";
      const refused = await signIn("good-code", { setup: false });
      expect(decodeURIComponent(refused.headers.get("location")!)).toContain("no owner yet");
      expect((await panel("/api/me")).status).toBe(401);

      const token = await setupToken();
      await signIn();
      expect(await json(panel("/api/me"))).toMatchObject({ role: "owner", admin: true });
      expect(await setupToken()).toBeNull();
      expect(await json(panel("/api/setup"))).toEqual({ needsOwner: false });

      // The used link makes nobody else owner.
      jar.clear();
      idp.email = "bob@agency.test";
      idp.sub = "u-bob";
      const login = await panel(`/auth/login?setup=${token}`);
      idp.nonce = new URL(login.headers.get("location")!).searchParams.get("nonce")!;
      await panel(`/auth/callback?code=good-code&state=${new URL(login.headers.get("location")!).searchParams.get("state")}`);
      expect(await json(panel("/api/me"))).toMatchObject({ role: null, admin: false, permissions: [] });
    } finally {
      env.DB = outer;
    }
  });
});

describe("members", () => {
  test("invites by email become memberships at sign-in; the owner can't be touched", async () => {
    await as("jane@agency.test", "u-jane");
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "carol@agency.test", role: "admin" }) })).status).toBe(201);
    const { members } = await json(panel("/api/members"));
    const carol = members.find((m: { email: string }) => m.email === "carol@agency.test");
    expect(carol).toMatchObject({ invited: true, role: "admin" });
    const owner = members.find((m: { role: string }) => m.role === "owner");

    await as("carol@agency.test", "u-carol");
    expect(await json(panel("/api/me"))).toMatchObject({ role: "admin", admin: true });
    // Admins can't demote or remove the owner.
    expect((await panel(`/api/members/${owner.id}`, { method: "PATCH", body: JSON.stringify({ role: "member" }) })).status).toBe(403);
    expect((await panel(`/api/members/${owner.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "x@agency.test", role: "owner" }) })).status).toBe(400);
  });

  test("custom hub roles grant some hub permissions", async () => {
    await as("jane@agency.test", "u-jane");
    expect((await panel("/api/hub-roles/site manager", { method: "PUT", body: JSON.stringify({ permissions: ["addSites"] }) })).status).toBe(200);
    expect((await panel("/api/hub-roles/bad", { method: "PUT", body: JSON.stringify({ permissions: ["fly"] }) })).status).toBe(400);
    await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "dan@agency.test", role: "site manager" }) });
    await as("dan@agency.test", "u-dan");
    expect(await json(panel("/api/me"))).toMatchObject({ role: "site manager", permissions: ["addSites"], admin: false });
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "y@agency.test" }) })).status).toBe(403);
  });
});

describe("sites, assignments and templates", () => {
  test("adding a site applies the default template, skipping what the site lacks; the adder manages it", async () => {
    bareSite("https://tpl.test");
    await as("jane@agency.test", "u-jane");
    const template = await json(panel("/api/templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Standard client setup",
        isDefault: true,
        roles: { editor: { "*": ["read", "write", "publish"] }, client: { post: ["read", "write"], homepage: ["read"], publish: false } }
      })
    }));
    expect(template).toMatchObject({ isDefault: true, summary: { editor: "All content" } });

    // A site manager adds it, so they own it on the hub and on the site.
    await as("dan@agency.test", "u-dan");
    const added = await json(panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://tpl.test" }) }));
    expect(added.template).toEqual({ state: "applied", skipped: ["client: homepage doesn't exist on this site"] });
    expect((await json(panel("/api/sites"))).map((s: { id: string }) => s.id)).toEqual([added.id]);

    const access = await json(panel(`/api/sites/${added.id}/access`));
    expect(access.canManage).toBe(true);
    expect(access.roles.map((r: { name: string }) => r.name)).toEqual(["client", "editor"]);
    expect(access.template).toMatchObject({ name: "Standard client setup", state: "applied" });
    expect(access.owners.find((o: { sub: string }) => o.sub === `${ISSUER}|u-dan`)).toMatchObject({ kind: "grant", adder: true });

    // Assigning by email before they've signed in; it follows them to their first sign-in.
    expect((await panel(`/api/sites/${added.id}/assignments`, { method: "PUT", body: JSON.stringify({ email: "erin@client.test", roles: ["client"] }) })).status).toBe(200);
    const { people } = await json(panel(`/api/sites/${added.id}/access`));
    expect(people).toEqual([expect.objectContaining({ principal: "email:erin@client.test", invited: true, roles: ["client"] })]);

    const previousAllow = env.PANEL_ALLOW;
    env.PANEL_ALLOW = "agency.test,client.test";
    try {
      await as("erin@client.test", "u-erin");
      expect((await json(panel("/api/sites"))).map((s: { id: string }) => s.id)).toEqual([added.id]);
      // A role, not a site owner: can't see the site's roles or change who has them.
      expect((await panel(`/api/sites/${added.id}/roles`)).status).toBe(403);
      const { code } = await json(panel(`/api/sites/${added.id}/code`, { method: "POST" }));
      const session = await json(sites["https://tpl.test"]!(new Request("https://tpl.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) })));
      expect(session.user.roles).toEqual(["client"]);
      expect(session.permissions.types.post).toMatchObject({ write: true, publish: false });
      expect(session.permissions.types.page.read).toBe(false);
    } finally {
      env.PANEL_ALLOW = previousAllow;
    }
  });

  test("an unreachable site leaves the template pending for the cron", async () => {
    bareSite("https://later.test");
    await as("jane@agency.test", "u-jane");
    const { templates } = await json(panel("/api/templates"));
    const handler = sites["https://later.test"]!;
    // Reachable for the descriptor, then down for the role API.
    sites["https://later.test"] = request => new URL(request.url).pathname.startsWith("/_vibe/api/") ? Promise.reject(new Error("down")) : handler(request);
    const added = await json(panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://later.test", templateId: templates[0].id }) }));
    expect(added.template.state).toBe("pending");
    sites["https://later.test"] = handler;
    const { retryTemplates } = await import("../src/server/access.ts");
    await retryTemplates(env);
    expect((await json(panel(`/api/sites/${added.id}/access`))).template).toMatchObject({ state: "applied" });

    // "No roles" is a choice too.
    bareSite("https://none.test");
    const none = await json(panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://none.test", templateId: null }) }));
    expect(none.template).toBeNull();
    expect((await json(panel(`/api/sites/${none.id}/roles`))).roles).toEqual([]);
  });
});
