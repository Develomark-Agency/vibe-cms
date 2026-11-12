import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineConfig } from "vibe-cms";
import { createHandler } from "vibe-cms/handler";
import v from "vibe-cms/schema";
import { createD1 } from "../../../packages/vibe-cms/test/helpers.ts";
import { env, idp, installMock, ISSUER, jar, ORG, panel, removeMock, setupToken, signIn, sites } from "./mock.ts";

/** A site with no roles of its own yet: what templates are for. */
function bareSite(origin: string) {
  const config = defineConfig({
    locales: ["en", "fr"],
    collections: {
      post: { schema: v.object({ title: v.text() }) },
      page: { schema: v.object({ title: v.text() }) }
    }
  });
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
  test("a PANEL_SETUP_TOKEN secret is the setup link's token, and stops working once the hub has an owner", async () => {
    const outer = env.DB;
    env.DB = createD1() as unknown as D1Database;
    env.PANEL_SETUP_TOKEN = "chosen-by-the-wizard";
    try {
      idp.email = "jane@agency.test";
      idp.sub = "u-jane";
      jar.clear();
      const wrong = await panel("/auth/login?setup=guess");
      idp.nonce = new URL(wrong.headers.get("location")!).searchParams.get("nonce")!;
      const refused = await panel(`/auth/callback?code=good-code&state=${new URL(wrong.headers.get("location")!).searchParams.get("state")}`);
      expect(decodeURIComponent(refused.headers.get("location")!)).toContain("no owner yet");

      jar.clear();
      const login = await panel("/auth/login?setup=chosen-by-the-wizard");
      idp.nonce = new URL(login.headers.get("location")!).searchParams.get("nonce")!;
      await panel(`/auth/callback?code=good-code&state=${new URL(login.headers.get("location")!).searchParams.get("state")}`);
      expect(await json(panel("/api/me"))).toMatchObject({ role: "owner" });

      // The secret stays on the Worker, but an owned hub no longer reads it.
      jar.clear();
      idp.email = "bob@agency.test";
      idp.sub = "u-bob";
      const again = await panel("/auth/login?setup=chosen-by-the-wizard");
      idp.nonce = new URL(again.headers.get("location")!).searchParams.get("nonce")!;
      await panel(`/auth/callback?code=good-code&state=${new URL(again.headers.get("location")!).searchParams.get("state")}`);
      expect(await json(panel("/api/me"))).toMatchObject({ role: null, admin: false });
    } finally {
      delete env.PANEL_SETUP_TOKEN;
      env.DB = outer;
    }
  });

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

describe("managing roles within your own", () => {
  test("someone whose site role manages roles gives out and edits only roles within it", async () => {
    bareSite("https://mgr.test");
    await as("jane@agency.test", "u-jane");
    const site = await json(panel("/api/sites", { method: "POST", body: JSON.stringify({ url: "https://mgr.test", templateId: null }) }));
    const template = await json(panel("/api/templates", { method: "POST", body: JSON.stringify({
      name: "Managed",
      roles: { lead: { post: ["read", "write", "publish"], manageRoles: true }, writer: { post: ["read", "write"] }, boss: { all: true } }
    }) }));
    expect((await json(panel(`/api/sites/${site.id}/template`, { method: "POST", body: JSON.stringify({ templateId: template.id }) }))).state).toBe("applied");
    await panel(`/api/sites/${site.id}/assignments`, { method: "PUT", body: JSON.stringify({ email: "bob@agency.test", roles: ["lead"] }) });

    await as("bob@agency.test", "u-bob");
    const access = await json(panel(`/api/sites/${site.id}/access`));
    expect(access).toMatchObject({ canManage: false, canAssign: true });
    expect(access.assignable.sort()).toEqual(["lead", "writer"]);
    expect((await panel(`/api/sites/${site.id}/assignments`, { method: "PUT", body: JSON.stringify({ email: "carol@agency.test", roles: ["writer"] }) })).status).toBe(200);
    const refused = await panel(`/api/sites/${site.id}/assignments`, { method: "PUT", body: JSON.stringify({ email: "carol@agency.test", roles: ["boss"] }) });
    expect(refused.status).toBe(403);
    // Not the site's owner on the hub: templates and owners stay out of reach.
    expect((await panel(`/api/sites/${site.id}/template`, { method: "POST", body: JSON.stringify({ templateId: template.id }) })).status).toBe(403);

    // On the site, a session the hub vouched for is short, and the same limits apply to editing roles.
    const { code } = await json(panel(`/api/sites/${site.id}/code`, { method: "POST" }));
    const session = await json(sites["https://mgr.test"]!(new Request("https://mgr.test/_vibe/api/session", { method: "POST", body: JSON.stringify({ code }) })));
    expect(session.expiresAt - Date.now() / 1000).toBeLessThanOrEqual(600);
    expect(session.permissions.roles).toBe(true);
    function roles(path: string, init: RequestInit = {}) {
      return sites["https://mgr.test"]!(new Request(`https://mgr.test/_vibe/api/roles${path}`, { ...init, headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" } }));
    }
    expect((await roles("/reviewer", { method: "PUT", body: JSON.stringify({ rules: { post: ["read"] } }) })).status).toBe(200);
    expect((await roles("/deleter", { method: "PUT", body: JSON.stringify({ rules: { post: ["read", "delete"] } }) })).status).toBe(403);
    expect((await roles("/root", { method: "PUT", body: JSON.stringify({ rules: { all: true } }) })).status).toBe(403);
    expect((await roles("/boss", { method: "DELETE" })).status).toBe(403);
    const listed = await json(roles(""));
    expect(listed.fullAccess).toBe(false);
    expect(listed.roles.find((role: { name: string }) => role.name === "boss").editable).toBe(false);
    expect(listed.roles.find((role: { name: string }) => role.name === "writer").editable).toBe(true);
  });

  test("hub roles and members only reach as far as your own hub permissions", async () => {
    await as("jane@agency.test", "u-jane");
    expect((await panel("/api/hub-roles/helper", { method: "PUT", body: JSON.stringify({ permissions: ["members", "roles"] }) })).status).toBe(200);
    await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "hal@agency.test", role: "helper" }) });
    await as("hal@agency.test", "u-hal");
    expect((await panel("/api/hub-roles/greeter", { method: "PUT", body: JSON.stringify({ permissions: ["members"] }) })).status).toBe(200);
    expect((await panel("/api/hub-roles/adder", { method: "PUT", body: JSON.stringify({ permissions: ["addSites"] }) })).status).toBe(403);
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "x1@agency.test", role: "greeter" }) })).status).toBe(201);
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "x2@agency.test", role: "admin" }) })).status).toBe(403);
    expect((await panel("/api/members", { method: "POST", body: JSON.stringify({ email: "x3@agency.test", role: "site manager" }) })).status).toBe(403);
  });
});
