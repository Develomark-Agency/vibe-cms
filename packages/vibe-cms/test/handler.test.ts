import { beforeEach, describe, expect, test } from "bun:test";
import { permissionSummary } from "../src/handler/auth.ts";
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

describe("trash", () => {
  async function uploadCover() {
    const form = new FormData();
    form.set("file", new File([png(1200, 600)], "cover.png", { type: "image/png" }));
    return (await t.api("/api/assets", { method: "POST", body: form })).body;
  }

  test("deleting a document moves it to the trash; restoring brings it back as it was", async () => {
    const created = await createPost({ title: "Gone", slug: "gone" });
    const deleted = await t.api(`/api/documents/post/${created.id}`, { method: "DELETE" });
    expect(deleted.body.trash).toMatch(/^trs_/);
    expect((await t.api(`/api/documents/post/${created.id}`)).status).toBe(404);
    expect(await t.vibe.client(t.env).query(post).findFirst()).toBeNull();

    const { body } = await t.api("/api/trash");
    expect(body.days).toBe(30);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: "document", type: "post", itemId: created.id, label: "Gone", locale: null });

    const restored = await t.api(`/api/trash/${deleted.body.trash}/restore`, { method: "POST" });
    expect(restored.status).toBe(200);
    expect((await t.vibe.client(t.env).query(post).findFirst())?.title).toBe("Gone");
    expect((await t.api(`/api/documents/post/${created.id}/versions`)).body.versions).toHaveLength(1);
    expect((await t.api("/api/trash")).body.items).toHaveLength(0);
  });

  test("a translation is trashed and restored on its own", async () => {
    const created = await createPost({ title: "Hello", slug: "hello" });
    await t.api(`/api/documents/post/${created.id}?locale=fr`, { method: "PUT", json: { data: { ...created.draft, title: "Bonjour" }, publish: true } });
    const deleted = await t.api(`/api/documents/post/${created.id}?locale=fr`, { method: "DELETE" });
    const client = t.vibe.client(t.env);
    expect((await client.query(post).findFirst({ locale: "fr" }))?.title).toBe("Hello");
    expect((await t.api("/api/trash")).body.items[0]).toMatchObject({ locale: "fr", label: "Bonjour" });
    await t.api(`/api/trash/${deleted.body.trash}/restore`, { method: "POST" });
    expect((await client.query(post).findFirst({ locale: "fr" }))?.title).toBe("Bonjour");
  });

  test("trashed files stop being served, come back with their URL, and purging deletes the bytes", async () => {
    const asset = await uploadCover();
    const url = `https://site.test/_vibe/media/${asset.id}.png`;
    const deleted = await t.api(`/api/assets/${asset.id}`, { method: "DELETE" });
    expect((await t.vibe.handle(new Request(url), t.env, ctx)).status).toBe(404);
    expect(t.env.MEDIA.objects.has(`assets/${asset.id}`)).toBe(true);

    await t.api(`/api/trash/${deleted.body.trash}/restore`, { method: "POST" });
    expect((await t.vibe.handle(new Request(url), t.env, ctx)).status).toBe(200);

    const again = await t.api(`/api/assets/${asset.id}`, { method: "DELETE" });
    expect((await t.api(`/api/trash/${again.body.trash}`, { method: "DELETE" })).body).toEqual({ purged: true });
    expect(t.env.MEDIA.objects.has(`assets/${asset.id}`)).toBe(false);
    expect((await t.api(`/api/trash/${again.body.trash}/restore`, { method: "POST" })).status).toBe(404);
  });

  test("restoring a document restores the files it used", async () => {
    const asset = await uploadCover();
    const created = await createPost({ title: "Pic", slug: "pic", cover: { asset: asset.id, alt: "" } });
    const doc = await t.api(`/api/documents/post/${created.id}`, { method: "DELETE" });
    // No longer used by a live document, so it can be deleted too.
    expect((await t.api(`/api/assets/${asset.id}`, { method: "DELETE" })).status).toBe(200);
    await t.api(`/api/trash/${doc.body.trash}/restore`, { method: "POST" });
    expect((await t.vibe.client(t.env).query(post).findFirst())?.cover?.width).toBe(1200);
    expect((await t.api("/api/trash")).body.items).toHaveLength(0);
  });

  test("the cron purges items past retention, with their history", async () => {
    const created = await createPost({ title: "Old", slug: "old" });
    await t.api(`/api/documents/post/${created.id}`, { method: "DELETE" });
    await t.vibe.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 29 * 86_400_000 }, t.env, ctx);
    expect((await t.api("/api/trash")).body.items).toHaveLength(1);
    await t.vibe.scheduled({ cron: "* * * * *", scheduledTime: Date.now() + 31 * 86_400_000 }, t.env, ctx);
    expect((await t.api("/api/trash")).body.items).toHaveLength(0);
    expect(t.env.DB.sqlite.query("SELECT COUNT(*) AS n FROM vibe_versions WHERE id = ?").get(created.id)).toEqual({ n: 0 });
  });

  test("trashed items can be previewed, files only by signed-in editors", async () => {
    const created = await createPost({ title: "Peek", slug: "peek" });
    const doc = await t.api(`/api/documents/post/${created.id}`, { method: "DELETE" });
    const detail = await t.api(`/api/trash/${doc.body.trash}`);
    expect(detail.body.documents).toEqual([expect.objectContaining({ locale: "en", status: "published", data: expect.objectContaining({ title: "Peek" }) })]);

    const asset = await uploadCover();
    const file = await t.api(`/api/assets/${asset.id}`, { method: "DELETE" });
    const fileDetail = await t.api(`/api/trash/${file.body.trash}`);
    expect(fileDetail.body.asset.url).toBe(`https://site.test/_vibe/api/trash/${file.body.trash}/file`);
    const bytes = await t.vibe.handle(new Request(fileDetail.body.asset.url, { headers: { authorization: `Bearer ${await token()}` } }), t.env, ctx);
    expect(bytes.status).toBe(200);
    expect(bytes.headers.get("content-type")).toBe("image/png");
    expect((await t.vibe.handle(new Request(fileDetail.body.asset.url), t.env, ctx)).status).toBe(401);
  });

  async function token() {
    return (await t.api("/api/session", { method: "POST", json: { dev: true } })).body.token as string;
  }

  test("emptying the trash, and anonymous users can't see it", async () => {
    await t.api(`/api/documents/post/${(await createPost({ title: "A", slug: "a" })).id}`, { method: "DELETE" });
    await t.api(`/api/assets/${(await uploadCover()).id}`, { method: "DELETE" });
    t.setToken("");
    expect((await t.api("/api/trash")).status).toBe(401);
    await t.signIn();
    expect((await t.api("/api/trash", { method: "DELETE" })).body).toEqual({ purged: 2 });
    expect(t.env.MEDIA.objects.size).toBe(0);
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
      accent: null,
      icon: null,
      auth: { issuer: "https://issuer.test", clientId: "panel" },
      admin: "https://site.test/_vibe/admin"
    });
  });
});

describe("folders", () => {
  async function upload(name: string, folder?: string) {
    const form = new FormData();
    form.set("file", new File([png(10, 10)], name, { type: "image/png" }));
    if(folder) form.set("folder", folder);
    return (await t.api("/api/assets", { method: "POST", body: form })).body;
  }

  test("folders nest, persist when empty, and move with their files", async () => {
    const a = await upload("a.png", "/posts//covers/");
    expect(a.folder).toBe("posts/covers");
    await t.api("/api/folders", { method: "POST", json: { path: "drafts" } });
    expect((await t.api("/api/folders")).body.folders).toEqual([
      { path: "drafts", files: 0 },
      { path: "posts", files: 0 },
      { path: "posts/covers", files: 1 }
    ]);

    // Moving a file out leaves its folder in place.
    await t.api(`/api/assets/${a.id}`, { method: "PATCH", json: { folder: "drafts" } });
    expect((await t.api("/api/folders")).body.folders.map((f: any) => f.path)).toContain("posts/covers");

    // Renaming a folder carries its subfolders and files.
    await t.api(`/api/assets/${a.id}`, { method: "PATCH", json: { folder: "posts/covers" } });
    const moved = await t.api("/api/folders", { method: "PATCH", json: { from: "posts", to: "archive/2026" } });
    expect(moved.body.path).toBe("archive/2026");
    expect((await t.api(`/api/assets/${a.id}`)).body.folder).toBe("archive/2026/covers");
    expect((await t.api("/api/assets?folder=archive/2026/covers")).body.total).toBe(1);

    expect((await t.api("/api/folders", { method: "PATCH", json: { from: "archive", to: "archive/inner" } })).status).toBe(400);
    expect((await t.api("/api/folders", { method: "PATCH", json: { from: "drafts", to: "archive" } })).status).toBe(409);
    expect((await t.api("/api/folders", { method: "POST", json: { path: "../up" } })).status).toBe(400);

    // Only empty folders can be deleted.
    expect((await t.api("/api/folders?path=archive", { method: "DELETE" })).status).toBe(409);
    expect((await t.api("/api/folders?path=drafts", { method: "DELETE" })).status).toBe(200);
    expect((await t.api("/api/folders")).body.folders.map((f: any) => f.path)).toEqual(["archive", "archive/2026", "archive/2026/covers"]);
  });
});

describe("text files", () => {
  test("edits replace content in place and bump the URL", async () => {
    const form = new FormData();
    // Browsers often send .md as octet-stream; the engine infers the type.
    form.set("file", new File(["# Hello"], "notes.md", { type: "application/octet-stream" }));
    const notes = (await t.api("/api/assets", { method: "POST", body: form })).body;
    expect(notes.mime).toBe("text/markdown");
    expect(notes.url).not.toContain("?v=");

    const edited = await t.api(`/api/assets/${notes.id}/content`, { method: "PUT", body: "# Hello, world" });
    expect(edited.status).toBe(200);
    expect(edited.body.url).toMatch(/\.md\?v=1$/);
    expect(edited.body.size).toBe(14);
    const served = await t.vibe.handle(new Request(edited.body.url), t.env, ctx);
    expect(await served.text()).toBe("# Hello, world");

    const image = new FormData();
    image.set("file", new File([png(10, 10)], "a.png", { type: "image/png" }));
    const png1 = (await t.api("/api/assets", { method: "POST", body: image })).body;
    expect((await t.api(`/api/assets/${png1.id}/content`, { method: "PUT", body: "nope" })).status).toBe(415);
  });
});

describe("site settings", () => {
  test("name, accent and icon override the config and show up everywhere", async () => {
    expect((await t.api("/api/site")).body).toEqual({ name: "Test site", accent: null, icon: null });

    const form = new FormData();
    form.set("file", new File([png(64, 64)], "logo.png", { type: "image/png" }));
    const logo = (await t.api("/api/assets", { method: "POST", body: form })).body;

    const saved = await t.api("/api/site", { method: "PATCH", json: { name: "  Acme  ", accent: "#2563EB", icon: logo.id } });
    expect(saved.body).toEqual({ name: "Acme", accent: "#2563eb", icon: { id: logo.id, url: logo.url } });

    const descriptor = await (await t.vibe.handle(new Request("https://site.test/.well-known/vibe-cms"), t.env, ctx)).json() as any;
    expect(descriptor).toMatchObject({ name: "Acme", accent: "#2563eb", icon: logo.url });
    expect((await t.api("/api/info")).body.settings.name).toBe("Acme");
    expect((await t.vibe.site(t.env)).icon?.url).toBe(`/_vibe/media/${logo.id}.png`);

    // The icon can't be deleted out from under the site.
    expect((await t.api(`/api/assets/${logo.id}`, { method: "DELETE" })).status).toBe(409);

    // The code's name again clears the override; null clears the rest.
    const reset = await t.api("/api/site", { method: "PATCH", json: { name: "Test site", accent: null, icon: null } });
    expect(reset.body).toEqual({ name: "Test site", accent: null, icon: null });
  });

  test("rejects bad values and needs the siteSettings permission", async () => {
    expect((await t.api("/api/site", { method: "PATCH", json: { accent: "orange" } })).status).toBe(400);
    expect((await t.api("/api/site", { method: "PATCH", json: { name: " " } })).status).toBe(400);
    expect((await t.api("/api/site", { method: "PATCH", json: { icon: "ast_missing" } })).status).toBe(400);
    t.setToken("");
    expect((await t.api("/api/site", { method: "PATCH", json: { name: "Nope" } })).status).toBe(401);
    // Writing content doesn't imply changing the site's branding.
    expect(permissionSummary(config, { sub: "x", roles: ["editor"] }).site).toBe(false);
  });
});

describe("session probe", () => {
  test("no credentials is not an error; a bad token is", async () => {
    t.setToken("");
    const anonymous = await t.api("/api/session");
    expect(anonymous.status).toBe(200);
    expect(anonymous.body).toEqual({ user: null });
    t.setToken("not-a-token");
    expect((await t.api("/api/session")).status).toBe(401);
  });
});

describe("unique fields and paths", () => {
  test("path format", async () => {
    const { validate } = await import("../src/schema/validate.ts");
    const v = (await import("../src/schema/index.ts")).default;
    expect(validate(v.text({ format: "path" }), "/about/team").issues).toEqual([]);
    expect(validate(v.text({ format: "path" }), "/").issues).toEqual([]);
    for(const bad of ["about", "/About", "/about/", "/a b", "//x"]) expect(validate(v.text({ format: "path" }), bad).issues).toHaveLength(1);
  });

  test("a unique field can't repeat within a type and locale", async () => {
    await createPost({ title: "One", slug: "hello" });
    const draft = await createPost({ title: "Two", slug: "hello" }, false);
    expect(draft.issues).toEqual([{ path: ["slug"], message: "Another document already uses “hello”" }]);
    const published = await t.api("/api/documents/post", { method: "POST", json: { data: { title: "Three", slug: "hello", tags: [], layout: "default" }, publish: true } });
    expect(published.status).toBe(422);
    // Editing the document that holds the value is fine.
    const again = await t.api(`/api/documents/post/${draft.id}`, { method: "PUT", json: { data: { ...draft.draft, slug: "hello-two" } } });
    expect(again.body.issues).toEqual([]);
  });
});

describe("actions", () => {
  test("every action is listed with its input schema", async () => {
    const { body } = await t.api("/api/actions");
    const names = body.actions.map((a: { name: string }) => a.name);
    expect(names).toContain("documents.create");
    const upload = body.actions.find((a: { name: string }) => a.name === "assets.upload");
    expect(upload.input.properties.file).toEqual({ type: "string", format: "binary", contentEncoding: "binary" });
    expect(upload.input.required).toEqual(["file"]);
  });

  test("any action runs by name, with the same results as its REST route", async () => {
    const created = await t.api("/api/actions/documents.create", { method: "POST", json: { type: "author", data: { name: "Ada" } } });
    expect(created.status).toBe(200);
    expect(created.body.status).toBe("draft");
    const fetched = await t.api(`/api/documents/author/${created.body.id}`);
    expect(fetched.body.draft).toEqual({ name: "Ada" });
    expect((await t.api("/api/actions/documents.nope", { method: "POST", json: {} })).status).toBe(404);
  });

  test("input is validated before the action runs, and errors carry a tag", async () => {
    const missing = await t.api("/api/actions/documents.create", { method: "POST", json: { data: {} } });
    expect(missing.status).toBe(400);
    expect(missing.body.tag).toBe("InvalidInput");
    expect(missing.body.details.issues[0].path).toEqual(["type"]);
    const unknown = await t.api("/api/documents/nope/x");
    expect(unknown.body).toEqual({ error: "Document not found", tag: "NotFound" });
  });

  test("content types are described as JSON Schema", async () => {
    const list = await t.api("/api/schema");
    expect(list.body.types.map((x: { type: string }) => x.type)).toEqual(["author", "post"]);
    const post = await t.api("/api/schema/post");
    expect(post.body.title).toBe("post");
    expect(post.body.properties.layout.enum).toEqual(["default", "wide"]);
  });
});

describe("mcp", () => {
  let id = 0;
  async function mcp(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    const response = await t.vibe.handle(
      new Request("https://site.test/_vibe/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
      }),
      t.env,
      ctx
    );
    return { status: response.status, body: response.status === 202 ? null : await response.json() as any };
  }

  test("initializes and lists every action as a tool", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.capabilities.tools).toBeDefined();
    const { body } = await mcp("tools/list");
    const tools = Object.fromEntries(body.result.tools.map((tool: { name: string }) => [tool.name, tool]));
    expect(tools.documents_create.inputSchema.type).toBe("object");
    expect(tools.trash_purge.annotations.destructiveHint).toBe(true);
    expect(tools.documents_list.annotations.readOnlyHint).toBe(true);
    expect(tools.assets_upload.inputSchema.properties.file.required).toEqual(["name", "base64"]);
  });

  test("tools run actions and report failures as tool errors", async () => {
    const schema = await mcp("tools/call", { name: "schema_get", arguments: { type: "post" } });
    expect(schema.body.result.structuredContent.properties.title.maxLength).toBe(120);

    const created = await mcp("tools/call", { name: "documents_create", arguments: { type: "post", data: { title: "From an agent", slug: "agent", tags: [], layout: "default" } } });
    const doc = created.body.result.structuredContent;
    expect(doc.status).toBe("draft");

    const bad = await mcp("tools/call", { name: "documents_update", arguments: { type: "post", id: doc.id, data: { title: "" }, publish: true } });
    expect(bad.body.result.isError).toBe(true);
    expect(bad.body.result.content[0].text).toStartWith("[Rejected]");

    const invalid = await mcp("tools/call", { name: "documents_get", arguments: { id: doc.id } });
    expect(invalid.body.result.content[0].text).toStartWith("[InvalidInput] type:");

    expect((await mcp("tools/call", { name: "nope" })).body.error.code).toBe(-32602);
  });

  test("files arrive base64-encoded", async () => {
    const base64 = btoa(String.fromCharCode(...png(20, 10)));
    const { body } = await mcp("tools/call", { name: "assets_upload", arguments: { file: { name: "tiny.png", base64 } } });
    const asset = body.result.structuredContent;
    expect(asset.mime).toBe("image/png");
    expect(asset.meta).toEqual({ width: 20, height: 10 });
  });

  test("notifications get no reply; other origins and anonymous production requests are refused", async () => {
    const note = await t.vibe.handle(
      new Request("https://site.test/_vibe/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }),
      t.env,
      ctx
    );
    expect(note.status).toBe(202);
    expect((await mcp("ping", {}, { origin: "https://evil.test" })).status).toBe(403);

    const production = createHandler(config, { dev: false, bindings: (e: typeof t.env) => ({ db: e.DB, storage: e.MEDIA }) });
    const anonymous = await production.handle(
      new Request("https://site.test/_vibe/api/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }),
      t.env,
      ctx
    );
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toBe("Bearer");
  });
});
