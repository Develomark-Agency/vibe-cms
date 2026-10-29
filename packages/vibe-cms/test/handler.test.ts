import { beforeEach, describe, expect, test } from "bun:test";
import { createHandler } from "../src/handler/index.ts";
import { and, desc, eq, gt, has, inArray } from "../src/query/index.ts";
import { calls, config } from "./fixture.ts";
import { createD1, createR2, ctx, png } from "./helpers.ts";

const { post, author } = config.schemas;

function setup() {
  const env = { DB: createD1(), MEDIA: createR2() };
  const vibe = createHandler(config, {
    dev: true,
    bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA })
  });
  let token = "";
  async function api(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if(token) headers.set("authorization", `Bearer ${token}`);
    if(init.json !== undefined) headers.set("content-type", "application/json");
    const response = await vibe.handle(
      new Request(`https://site.test/_vibe${path}`, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }),
      env,
      ctx
    );
    return { status: response.status, body: await response.json() as any };
  }
  async function signIn() {
    const { body } = await api("/api/session", { method: "POST", json: { dev: true } });
    token = body.token;
  }
  return { env, vibe, api, signIn, setToken: (t: string) => (token = t) };
}

let t: ReturnType<typeof setup>;

beforeEach(async () => {
  calls.length = 0;
  t = setup();
  await t.signIn();
});

async function createAuthor(name = "Ada") {
  const { body } = await t.api("/api/documents/author", { method: "POST", json: { data: { name }, publish: true } });
  return body.id as string;
}

async function createPost(data: Record<string, unknown>, publish = true) {
  const { status, body } = await t.api("/api/documents/post", {
    method: "POST",
    json: { data: { tags: [], layout: "default", ...data }, publish }
  });
  if(status >= 400) throw new Error(JSON.stringify(body));
  return body;
}

describe("documents", () => {
  test("drafts, publishing and status", async () => {
    const created = await createPost({ title: "Hello", slug: "hello" }, false);
    expect(created.status).toBe("draft");
    expect(created.draft.searchText).toBe("t:hello");

    const client = t.vibe.client(t.env);
    expect(await client.query(post).findMany()).toHaveLength(0);
    expect(await client.query(post, { drafts: true }).findMany()).toHaveLength(1);

    const published = await t.api(`/api/documents/post/${created.id}/publish`, { method: "POST", json: {} });
    expect(published.body.status).toBe("published");

    const edited = await t.api(`/api/documents/post/${created.id}`, {
      method: "PUT",
      json: { data: { ...published.body.draft, title: "Hello again" }, baseUpdatedAt: published.body.updatedAt }
    });
    expect(edited.body.status).toBe("changed");

    const stale = await t.api(`/api/documents/post/${created.id}`, {
      method: "PUT",
      json: { data: published.body.draft, baseUpdatedAt: published.body.updatedAt }
    });
    expect(stale.status).toBe(409);

    const live = await client.query(post).findFirst({ where: eq(post.slug, "hello") });
    expect(live?.title).toBe("Hello");
    expect(live?.$meta.status).toBe("changed");
    expect(calls).toContain("afterWrite:post:publish");
  });

  test("validation blocks publishing but not drafts", async () => {
    const draft = await t.api("/api/documents/post", { method: "POST", json: { data: { title: "", slug: "Bad Slug", tags: [], layout: "default" } } });
    expect(draft.status).toBe(201);
    expect(draft.body.issues.map((i: any) => i.path.join("."))).toEqual(["title", "slug"]);
    const publish = await t.api(`/api/documents/post/${draft.body.id}/publish`, { method: "POST", json: {} });
    expect(publish.status).toBe(422);
  });

  test("references must exist and can be expanded both ways", async () => {
    const missing = await t.api("/api/documents/post", {
      method: "POST",
      json: { data: { title: "x", slug: "x", tags: [], layout: "default", author: "doc_nope" }, publish: true }
    });
    expect(missing.status).toBe(422);
    expect(missing.body.details.issues[0].message).toMatch(/does not exist/);

    const ada = await createAuthor("Ada");
    const grace = await createAuthor("Grace");
    const first = await createPost({ title: "One", slug: "one", author: ada, publishedAt: "2026-02-01" });
    await createPost({ title: "Two", slug: "two", author: ada, publishedAt: "2026-03-01", related: [first.id] });
    await createPost({ title: "Three", slug: "three", author: grace, publishedAt: "2025-12-01" });

    const client = t.vibe.client(t.env);
    const posts = await client.query(post).findMany({
      where: gt(post.publishedAt, new Date("2026-01-01")),
      orderBy: [desc(post.publishedAt)],
      with: { author: true, related: true }
    });
    expect(posts.map(p => p.title)).toEqual(["Two", "One"]);
    expect(posts[0]!.author?.name).toBe("Ada");
    expect(posts[0]!.related?.[0]?.title).toBe("One");

    const authors = await client.query(author).findMany({
      where: inArray(author.id, [ada, grace]),
      orderBy: [desc(author.name)],
      with: { posts: { orderBy: [desc(post.publishedAt)], limit: 1 } }
    });
    expect(authors.map(a => [a.name, a.posts.map(p => p.title)])).toEqual([["Grace", ["Three"]], ["Ada", ["Two"]]]);

    const blocked = await t.api(`/api/documents/author/${ada}`, { method: "DELETE" });
    expect(blocked.status).toBe(409);
  });

  test("array filters and counts", async () => {
    await createPost({ title: "A", slug: "a", tags: ["news", "cms"] });
    await createPost({ title: "B", slug: "b", tags: ["cms"], layout: "wide" });
    const client = t.vibe.client(t.env);
    expect(await client.query(post).count({ where: has(post.tags, "cms") })).toBe(2);
    const wide = await client.query(post).findMany({ where: and(has(post.tags, "cms"), eq(post.layout, "wide")) });
    expect(wide.map(p => p.title)).toEqual(["B"]);
  });

  test("i18n falls back to the default locale", async () => {
    const created = await createPost({ title: "Hello", slug: "hello" });
    const client = t.vibe.client(t.env);
    expect((await client.query(post).findFirst({ locale: "fr" }))?.title).toBe("Hello");
    await t.api(`/api/documents/post/${created.id}?locale=fr`, {
      method: "PUT",
      json: { data: { ...created.draft, title: "Bonjour" }, publish: true }
    });
    expect((await client.query(post).findFirst({ locale: "fr" }))?.title).toBe("Bonjour");
    expect((await client.query(post).findFirst({ locale: "en" }))?.title).toBe("Hello");
    const doc = await t.api(`/api/documents/post/${created.id}?locale=fr`);
    expect(doc.body.locales.map((l: any) => l.locale).sort()).toEqual(["en", "fr"]);
  });

  test("versions and restore", async () => {
    const created = await createPost({ title: "V1", slug: "v" });
    await t.api(`/api/documents/post/${created.id}`, { method: "PUT", json: { data: { ...created.draft, title: "V2" }, publish: true } });
    const { body } = await t.api(`/api/documents/post/${created.id}/versions`);
    expect(body.versions.map((v: any) => v.ver)).toEqual([2, 1]);
    const restored = await t.api(`/api/documents/post/${created.id}/versions/1/restore`, { method: "POST", json: {} });
    expect(restored.body.draft.title).toBe("V1");
    expect(restored.body.status).toBe("changed");
  });

  test("scheduled publishing", async () => {
    const created = await createPost({ title: "Later", slug: "later" }, false);
    const runAt = new Date(Date.now() + 60_000).toISOString();
    const scheduled = await t.api(`/api/documents/post/${created.id}/schedule`, { method: "POST", json: { action: "publish", runAt } });
    expect(scheduled.body.schedules).toHaveLength(1);
    // Edits after scheduling don't sneak into the scheduled publish.
    await t.api(`/api/documents/post/${created.id}`, { method: "PUT", json: { data: { ...created.draft, title: "Edited" } } });
    await t.vibe.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 120_000 }, t.env, ctx);
    const client = t.vibe.client(t.env);
    const live = await client.query(post).findFirst();
    expect(live?.title).toBe("Later");
    expect(live?.$meta.status).toBe("changed");
  });

  test("plugins can cancel deletes and add routes", async () => {
    await t.api("/api/documents/post", { method: "POST", json: { id: "protected", data: { title: "P", slug: "p", tags: [], layout: "default" } } });
    const response = await t.api("/api/documents/post/protected", { method: "DELETE" });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("This one is protected");
    const hello = await t.api("/plugins/audit/hello/world");
    expect(hello.body).toEqual({ hello: "world" });
  });
});

describe("media", () => {
  test("upload, validation against the field, and resolution in queries", async () => {
    async function upload(bytes: Uint8Array<ArrayBuffer>, field?: string) {
      const form = new FormData();
      form.set("file", new File([bytes], "cover.png", { type: "image/png" }));
      if(field) {
        form.set("type", "post");
        form.set("field", field);
      }
      return t.api("/api/assets", { method: "POST", body: form });
    }
    const small = await upload(png(50, 50), "cover");
    expect(small.status).toBe(422);
    expect(small.body.error).toMatch(/at least 100px/);

    const big = await upload(png(1200, 600), "cover");
    expect(big.status).toBe(201);
    expect(big.body.meta).toEqual({ width: 1200, height: 600 });

    await createPost({ title: "Pic", slug: "pic", cover: { asset: big.body.id, alt: "A picture" } });
    const live = await t.vibe.client(t.env).query(post).findFirst();
    expect(live?.cover?.url).toBe(`/_vibe/media/${big.body.id}.png`);
    expect(live?.cover?.width).toBe(1200);
    expect(live?.cover?.alt).toBe("A picture");

    const served = await t.vibe.handle(new Request(`https://site.test${live!.cover!.url}`), t.env, ctx);
    expect(served.headers.get("content-type")).toBe("image/png");

    const inUse = await t.api(`/api/assets/${big.body.id}`, { method: "DELETE" });
    expect(inUse.status).toBe(409);
  });
});

describe("auth", () => {
  test("anonymous users read published content but not drafts or the editor API", async () => {
    await createPost({ title: "Public", slug: "public" });
    t.setToken("");
    const query = await t.api("/api/query", { method: "POST", json: { queries: [{ type: "post", op: "findMany", args: {} }] } });
    expect(query.body.results[0]).toHaveLength(1);
    const drafts = await t.api("/api/query", { method: "POST", json: { queries: [{ type: "post", op: "findMany", args: {}, drafts: true }] } });
    expect(drafts.status).toBe(401);
    expect((await t.api("/api/documents/post")).status).toBe(401);
  });

  test("site descriptor", async () => {
    const response = await t.vibe.handle(new Request("https://site.test/.well-known/vibe-cms"), t.env, ctx);
    expect(await response.json()).toEqual({
      protocol: 1,
      id: "test-site",
      name: "Test site",
      auth: { issuer: "https://issuer.test", clientId: "panel" },
      admin: "https://site.test/_vibe/admin"
    });
  });
});
