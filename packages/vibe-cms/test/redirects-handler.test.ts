import { beforeEach, describe, expect, test } from "bun:test";
import { defineConfig } from "../src/index.ts";
import { createHandler } from "../src/handler/index.ts";
import { can, issueSession, permissionSummary } from "../src/handler/auth.ts";
import { beyondReach } from "../src/roles.ts";
import v from "../src/schema/index.ts";
import { createD1, ctx } from "./helpers.ts";

const config = defineConfig({
  schemas: {
    page: v.object({
      title: v.text({ min: 1 }),
      path: v.text({ format: "path", indexed: true, unique: true })
    }),
    post: v.object({
      title: v.text({ min: 1 }),
      slug: v.text({ format: "slug", indexed: true, unique: true })
    }),
    note: v.object({ title: v.text({ min: 1 }) })
  },
  collections: { post: { url: "/blog/{slug}" } }
});

const roles = {
  editor: { "*": ["read", "write", "publish", "delete"] },
  webmaster: { siteSettings: true },
  webmasterNoRedirects: { siteSettings: true, manageRedirects: false },
  redirector: { manageRedirects: true }
} as const;

function setup() {
  const env = { DB: createD1({ roles: roles as never }), VIBE_ORG: "https://hub.test" };
  const seen: string[] = [];
  const pending: Array<Promise<unknown>> = [];
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB }) });
  const worker = vibe({
    async fetch(request) {
      seen.push(new URL(request.url).pathname);
      return new Response("site");
    }
  });
  const waiting = { ...ctx, waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };
  let token = "";
  async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if(token) headers.set("authorization", `Bearer ${token}`);
    if(init.json !== undefined) headers.set("content-type", "application/json");
    const response = await vibe.handle(new Request(`https://site.test/_vibe${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env, waiting as never);
    return { status: response.status, body: await response.json() as any };
  }
  async function visit(path: string, method = "GET") {
    const response = await worker.fetch(new Request(`https://site.test${path}`, { method, redirect: "manual" }), env, waiting as never);
    await Promise.all(pending.splice(0));
    return response;
  }
  return { env, vibe, worker, api, visit, seen, signIn: async () => { token = (await api("/api/session", { method: "POST", json: { dev: true } })).body.token; } };
}

let t: ReturnType<typeof setup>;
beforeEach(async () => {
  t = setup();
  await t.signIn();
});

async function add(from: string, to: string, extra: Record<string, unknown> = {}) {
  return t.api("/api/redirects", { method: "POST", json: { from, to, ...extra } });
}

describe("serving", () => {
  test("redirects before the site's own fetch, GET and HEAD only", async () => {
    await add("/old", "/new");
    const hit = await t.visit("/old?x=1");
    expect(hit.status).toBe(301);
    expect(hit.headers.get("location")).toBe("/new?x=1");
    expect((await t.visit("/old", "HEAD")).status).toBe(301);
    expect(t.seen).toEqual([]);
    expect((await t.visit("/old", "POST")).status).toBe(200);
    expect((await t.visit("/other")).status).toBe(200);
    expect(t.seen).toEqual(["/old", "/other"]);
  });

  test("wildcards, status, and a trailing slash", async () => {
    await add("/blog/*", "/news/*", { status: 308 });
    const hit = await t.visit("/blog/2024/a/");
    expect(hit.status).toBe(308);
    expect(hit.headers.get("location")).toBe("/news/2024/a/");
  });

  test("the CMS's own routes are never redirected", async () => {
    expect((await add("/_vibe/api/info", "/x")).status).toBe(400);
    expect((await add("/_vibe/*", "/x")).status).toBe(400);
    expect((await t.api("/api/info")).status).toBe(200);
  });

  test("changes made elsewhere show up once the version is checked, and hits are counted", async () => {
    const realNow = Date.now;
    await add("/a", "/b");
    expect((await t.visit("/a")).status).toBe(301);
    // Another isolate's write: the version changes under this isolate's cache.
    t.env.DB.sqlite.run("DELETE FROM vibe_redirects");
    t.env.DB.sqlite.run("INSERT OR REPLACE INTO vibe_meta (key, value) VALUES ('redirects_version', 'other')");
    Date.now = () => realNow() + 10_000;
    try {
      expect((await t.visit("/a")).status).toBe(200);
    } finally {
      Date.now = realNow;
    }
    const list = await t.api("/api/redirects");
    expect(list.body.total).toBe(0);
    await add("/c", "/d");
    // Counts are written at most every few seconds per isolate: the first visit above already flushed.
    Date.now = () => realNow() + 20_000;
    try {
      await t.visit("/c");
    } finally {
      Date.now = realNow;
    }
    const after = await t.api("/api/redirects");
    expect(after.body.redirects[0]).toMatchObject({ from: "/c", hits: 1 });
    expect(after.body.redirects[0].lastHitAt).not.toBeNull();
  });
});

describe("rules", () => {
  test("create, list, search, update and delete", async () => {
    const made = await add("/Old/", "/new", { status: 302, keepQuery: false });
    expect(made.status).toBe(201);
    expect(made.body.redirect).toMatchObject({ from: "/Old", to: "/new", status: 302, keepQuery: false, source: "manual", hits: 0 });
    await add("/other", "https://example.com/x");
    expect((await t.api("/api/redirects?search=example")).body.total).toBe(1);
    const id = made.body.redirect.id;
    const changed = await t.api(`/api/redirects/${id}`, { method: "PATCH", json: { to: "/newer" } });
    expect(changed.body.redirect).toMatchObject({ to: "/newer", status: 302 });
    expect((await t.visit("/Old")).headers.get("location")).toBe("/newer");
    expect((await t.api(`/api/redirects/${id}`, { method: "DELETE" })).body).toEqual({ deleted: true });
    expect((await t.visit("/Old")).status).toBe(200);
  });

  test("variables are served, with the query kept", async () => {
    const made = await add("/hello/{segA}/goodbye/{segB}", "/bye/{segB}?a={segA}", { status: 302 });
    expect(made.status).toBe(201);
    const hit = await t.visit("/hello/x/goodbye/y?z=1");
    expect(hit.status).toBe(302);
    expect(hit.headers.get("location")).toBe("/bye/y?a=x&z=1");
    expect((await add("/p/{id}", "/q/{nope}")).status).toBe(400);
  });

  test("query parameters are matched and used up", async () => {
    expect((await add("/place?town={townName}", "/connecticut/{townName}", { status: 302 })).status).toBe(201);
    const hit = await t.visit("/place?town=hartford&utm=1");
    expect(hit.status).toBe(302);
    expect(hit.headers.get("location")).toBe("/connecticut/hartford?utm=1");
    expect((await t.visit("/place")).status).toBe(200);
    expect((await add("/place?town={other}", "/x/{other}")).status).toBe(409);
  });

  test("refuses duplicates and loops", async () => {
    await add("/a", "/b");
    expect((await add("/a", "/c")).status).toBe(409);
    const loop = await add("/b", "/a");
    expect(loop.status).toBe(409);
    expect(loop.body.error).toMatch(/loop/);
    expect((await add("/w/*", "/w/x/*")).status).toBe(409);
  });

  test("a rule that ends a chain re-points the ones leading to it", async () => {
    await add("/a", "/b");
    const moved = await add("/b", "/c");
    expect(moved.body.repointed).toBe(1);
    expect((await t.visit("/a")).headers.get("location")).toBe("/c");
    expect((await t.visit("/b")).headers.get("location")).toBe("/c");
  });

  test("warns when it hides a live page", async () => {
    await t.api("/api/documents/page", { method: "POST", json: { data: { title: "About", path: "/about" }, publish: true } });
    const made = await add("/about", "/team");
    expect(made.status).toBe(201);
    expect(made.body.warnings[0]).toMatch(/\/about is a live page/);
  });

  test("imports what it can and says why for the rest", async () => {
    const done = await t.api("/api/redirects/import", { method: "POST", json: { rows: [{ from: "/a", to: "/b" }, { from: "/a", to: "/c" }, { from: "nope", to: "/x" }, { from: "/c", to: "/d" }] } });
    expect(done.body.created).toBe(2);
    expect(done.body.skipped.map((s: { row: number }) => s.row)).toEqual([2, 3]);
  });
});

describe("automatic redirects", () => {
  async function publishPost(slug: string) {
    const { body } = await t.api("/api/documents/post", { method: "POST", json: { data: { title: "Hi", slug }, publish: true } });
    return body.id as string;
  }

  async function rename(id: string, slug: string, redirect?: boolean) {
    const current = (await t.api(`/api/documents/post/${id}`)).body;
    await t.api(`/api/documents/post/${id}`, { method: "PUT", json: { data: { ...current.draft, slug }, baseUpdatedAt: current.updatedAt } });
    const suggestion = (await t.api(`/api/documents/post/${id}/redirect`)).body.suggestion;
    const published = await t.api(`/api/documents/post/${id}/publish`, { method: "POST", json: { redirect } });
    return { suggestion, published };
  }

  test("a slug change suggests a redirect, and publishing makes it when asked", async () => {
    const id = await publishPost("one");
    const { suggestion, published } = await rename(id, "two", true);
    expect(suggestion).toEqual({ from: "/blog/one", to: "/blog/two", exists: false });
    expect(published.body.redirect).toEqual({ from: "/blog/one", to: "/blog/two", created: true });
    const rule = (await t.api("/api/redirects")).body.redirects[0];
    expect(rule).toMatchObject({ from: "/blog/one", to: "/blog/two", source: "slug-change", documentId: id });
    expect((await t.visit("/blog/one")).headers.get("location")).toBe("/blog/two");
  });

  test("without the box ticked nothing is added; a type without URLs offers nothing", async () => {
    const id = await publishPost("one");
    const { published } = await rename(id, "two", false);
    expect(published.body.redirect).toBeUndefined();
    expect((await t.api("/api/redirects")).body.total).toBe(0);
    const note = (await t.api("/api/documents/note", { method: "POST", json: { data: { title: "x" }, publish: true } })).body.id;
    expect((await t.api(`/api/documents/note/${note}/redirect`)).body.suggestion).toBeNull();
  });

  test("renaming again keeps visitors to one hop", async () => {
    const id = await publishPost("one");
    await rename(id, "two", true);
    await rename(id, "three", true);
    expect((await t.visit("/blog/one")).headers.get("location")).toBe("/blog/three");
    expect((await t.visit("/blog/two")).headers.get("location")).toBe("/blog/three");
  });

  test("renaming back removes the redirect that left", async () => {
    const id = await publishPost("one");
    await rename(id, "two", true);
    await rename(id, "one", false);
    expect((await t.visit("/blog/one")).status).toBe(200);
    expect((await t.api("/api/redirects")).body.redirects.map((r: { from: string }) => r.from)).toEqual([]);
  });

  test("a manual redirect from the old address isn't overwritten", async () => {
    await add("/blog/one", "/elsewhere");
    const id = await publishPost("one");
    const { published } = await rename(id, "two", true);
    expect(published.body.redirect).toMatchObject({ created: false });
    expect((await t.visit("/blog/one")).headers.get("location")).toBe("/elsewhere");
  });

  describe("scheduled", () => {
    function runAt() {
      return new Date(Date.now() + 60 * 60 * 1000);
    }

    async function renameDraft(id: string, slug: string) {
      const current = (await t.api(`/api/documents/post/${id}`)).body;
      await t.api(`/api/documents/post/${id}`, { method: "PUT", json: { data: { ...current.draft, slug }, baseUpdatedAt: current.updatedAt } });
    }

    async function runDue(at: Date) {
      await t.vibe.scheduled({ scheduledTime: at.getTime() + 1000, cron: "* * * * *" } as never, t.env, ctx);
    }

    test("a scheduled publish carries the choice, and makes the redirect when it runs", async () => {
      const id = await publishPost("one");
      await renameDraft(id, "two");
      const at = runAt();
      const scheduled = await t.api(`/api/documents/post/${id}/schedule`, { method: "POST", json: { action: "publish", runAt: at.toISOString(), redirect: true } });
      expect(scheduled.body.redirect).toEqual({ from: "/blog/one", to: "/blog/two" });
      expect(scheduled.body.schedules).toMatchObject([{ action: "publish", redirect: true }]);
      // Not yet: the old address still works until it runs.
      expect((await t.api("/api/redirects")).body.total).toBe(0);
      await runDue(at);
      expect((await t.api("/api/redirects")).body.redirects[0]).toMatchObject({ from: "/blog/one", to: "/blog/two", source: "slug-change", documentId: id });
      expect((await t.visit("/blog/one")).headers.get("location")).toBe("/blog/two");
    });

    test("without the choice no redirect is made, and a schedule that doesn't change the address makes none", async () => {
      const id = await publishPost("one");
      await renameDraft(id, "two");
      const at = runAt();
      const plain = await t.api(`/api/documents/post/${id}/schedule`, { method: "POST", json: { action: "publish", runAt: at.toISOString() } });
      expect(plain.body.redirect).toBeUndefined();
      await runDue(at);
      expect((await t.api("/api/redirects")).body.total).toBe(0);
      // Asked for, but the address stays: nothing to redirect.
      await t.api(`/api/documents/post/${id}`, { method: "PUT", json: { data: { ...(await t.api(`/api/documents/post/${id}`)).body.draft, title: "Retitled" }, baseUpdatedAt: (await t.api(`/api/documents/post/${id}`)).body.updatedAt } });
      const same = await t.api(`/api/documents/post/${id}/schedule`, { method: "POST", json: { action: "publish", runAt: at.toISOString(), redirect: true } });
      expect(same.body.redirect).toBeUndefined();
      await runDue(at);
      expect((await t.api("/api/redirects")).body.total).toBe(0);
    });

    test("a page scheduled back to an address it left loses the redirect that left", async () => {
      const id = await publishPost("one");
      await renameDraft(id, "two");
      await t.api(`/api/documents/post/${id}/publish`, { method: "POST", json: { redirect: true } });
      expect((await t.api("/api/redirects")).body.total).toBe(1);
      await renameDraft(id, "one");
      const at = runAt();
      await t.api(`/api/documents/post/${id}/schedule`, { method: "POST", json: { action: "publish", runAt: at.toISOString() } });
      await runDue(at);
      expect((await t.api("/api/redirects")).body.total).toBe(0);
    });

    test("asking for the redirect needs permission to manage redirects", async () => {
      const id = await publishPost("one");
      await renameDraft(id, "two");
      const siteId = (t.env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site_id'").get() as { value: string }).value;
      const { token } = await issueSession(t.env.DB, { sub: "ed", roles: ["editor"], name: "Ed" }, siteId, "https://site.test");
      async function schedule(redirect: boolean) {
        const response = await t.vibe.handle(new Request(`https://site.test/_vibe/api/documents/post/${id}/schedule`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ action: "publish", runAt: runAt().toISOString(), redirect })
        }), t.env, ctx);
        return response.status;
      }
      expect(await schedule(true)).toBe(403);
      // Scheduling without it is fine for an editor who can publish.
      expect(await schedule(false)).toBe(200);
    });
  });

  test("trashing a page redirects it; restoring takes the redirect away", async () => {
    const id = await publishPost("one");
    const gone = await t.api(`/api/documents/post/${id}?redirectTo=${encodeURIComponent("/blog")}`, { method: "DELETE" });
    expect(gone.body.redirects).toEqual([{ from: "/blog/one", to: "/blog", created: true }]);
    expect((await t.api("/api/redirects")).body.redirects[0]).toMatchObject({ source: "trash", documentId: id });
    expect((await t.visit("/blog/one")).headers.get("location")).toBe("/blog");
    await t.api(`/api/trash/${gone.body.trash}/restore`, { method: "POST" });
    expect((await t.api("/api/redirects")).body.total).toBe(0);
    expect((await t.visit("/blog/one")).status).toBe(200);
  });

  test("a redirect made for a deleted page is tied to it, and restoring removes it", async () => {
    const id = await publishPost("one");
    expect((await t.api(`/api/documents/post/${id}/redirect`)).body).toEqual({ suggestion: null, hasUrl: true, url: "/blog/one" });
    const gone = await t.api(`/api/documents/post/${id}`, { method: "DELETE" });
    expect((await t.api("/api/redirects")).body.total).toBe(0);
    const made = await add("/blog/one", "/blog", { deletedDocument: { id, type: "post" } });
    expect(made.body.redirect).toMatchObject({ source: "trash", documentId: id, documentType: "post", from: "/blog/one" });
    await t.api(`/api/trash/${gone.body.trash}/restore`, { method: "POST" });
    expect((await t.api("/api/redirects")).body.total).toBe(0);
    expect((await add("/x", "/y", { deletedDocument: { id, type: "nope" } })).status).toBeGreaterThanOrEqual(400);
  });

  test("pageSchema-style path fields are pages too", async () => {
    const page = (await t.api("/api/documents/page", { method: "POST", json: { data: { title: "About", path: "/about" }, publish: true } })).body;
    const current = (await t.api(`/api/documents/page/${page.id}`)).body;
    await t.api(`/api/documents/page/${page.id}`, { method: "PUT", json: { data: { ...current.draft, path: "/about-us" }, baseUpdatedAt: current.updatedAt } });
    expect((await t.api(`/api/documents/page/${page.id}/redirect`)).body.suggestion).toEqual({ from: "/about", to: "/about-us", exists: false });
  });
});

describe("permission", () => {
  test("siteSettings has it unless manageRedirects is false; manageRedirects stands alone", () => {
    const access = { config, roles: { map: roles as never } };
    function as(name: string) {
      return { sub: name, roles: [name] };
    }
    function can_(name: string) {
      return can(access, as(name), { action: "write", scope: "redirects" });
    }
    expect(can_("webmaster")).toBe(true);
    expect(can_("webmasterNoRedirects")).toBe(false);
    expect(can_("redirector")).toBe(true);
    expect(can_("editor")).toBe(false);
    expect(permissionSummary(access, as("redirector")).redirects).toBe(true);
    expect(beyondReach({ manageRedirects: true }, [roles.editor as never], { types: [], locales: [] })).toEqual(["managing redirects"]);
    expect(beyondReach({ manageRedirects: true }, [roles.webmaster as never], { types: [], locales: [] })).toEqual([]);
  });
});
