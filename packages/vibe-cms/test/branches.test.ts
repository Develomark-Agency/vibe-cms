import { beforeEach, describe, expect, test } from "bun:test";
import { issueSession } from "../src/handler/auth.ts";
import { createHandler } from "../src/handler/index.ts";
import { migrations } from "../src/db/migrations/index.ts";
import { config, roles } from "./fixture.ts";
import { createD1, createR2, ctx } from "./helpers.ts";

function setup(db = createD1({ roles: { ...roles, publisher: { post: ["read", "write", "publish"] } } })) {
  const env = { DB: db, MEDIA: createR2() };
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) });
  async function call(token: string, action: string, input: Record<string, unknown>, via = "ui") {
    const response = await vibe.handle(new Request(`https://site.test/_vibe/api/actions/${action}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-vibe-via": via },
      body: JSON.stringify(input)
    }), env, ctx);
    return { status: response.status, body: await response.json() as any };
  }
  async function token(session: { sub: string, roles: string[], name?: string }) {
    if(session.sub === "dev") {
      const response = await vibe.handle(new Request("https://site.test/_vibe/api/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) }), env, ctx);
      return ((await response.json()) as { token: string }).token;
    }
    await vibe.handle(new Request("https://site.test/_vibe/api/info"), env, ctx);
    const siteId = (env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site_id'").get() as { value: string }).value;
    return (await issueSession(env.DB, session, siteId, "https://site.test")).token;
  }
  return { env, vibe, call, token };
}

let t: ReturnType<typeof setup>;
let dev: string;
let alice: string;
let bob: string;

const post = { title: "Spring sale", slug: "sale", tags: [], layout: "default", seo: { description: "Old" } };

async function ok(promise: Promise<{ status: number, body: any }>) {
  const { status, body } = await promise;
  if(status >= 400) throw new Error(`${status} ${JSON.stringify(body)}`);
  return body;
}

async function published() {
  return ok(t.call(dev, "documents.create", { type: "post", data: post, publish: true }));
}

async function edit(token: string, id: string, change: Record<string, unknown>) {
  const doc = await ok(t.call(token, "documents.get", { type: "post", id }));
  return ok(t.call(token, "documents.update", { type: "post", id, data: { ...doc.draft, ...change }, baseUpdatedAt: doc.updatedAt, baseVer: doc.baseVer }));
}

beforeEach(async () => {
  t = setup();
  dev = await t.token({ sub: "dev", roles: ["dev"] });
  alice = await t.token({ sub: "alice", roles: ["editor"], name: "Alice" });
  bob = await t.token({ sub: "bob", roles: ["publisher"], name: "Bob" });
});

describe("branches", () => {
  test("each person saves their own copy; publishing merges them", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    await edit(bob, doc.id, { seo: { description: "Bob's" } });

    const asAlice = await ok(t.call(alice, "documents.get", { type: "post", id: doc.id }));
    expect(asAlice).toMatchObject({ status: "changed", mine: true, draft: { title: "Summer sale", seo: { description: "Old" } }, published: { title: "Spring sale" } });
    expect(asAlice.pending.map((p: any) => [p.owner, p.name, p.via])).toEqual([["bob", "Bob", "ui"], ["alice", "Alice", "ui"]]);
    const asBob = await ok(t.call(bob, "documents.get", { type: "post", id: doc.id }));
    expect(asBob.draft).toMatchObject({ title: "Spring sale", seo: { description: "Bob's" } });

    const changes = await ok(t.call(dev, "documents.changes", { type: "post", id: doc.id }));
    expect(changes.branches.map((b: any) => [b.owner, b.changes.map((c: any) => [c.path, c.before, c.after, c.status])])).toEqual([
      ["bob", [["seo.description", "Old", "Bob's", "clean"]]],
      ["alice", [["title", "Spring sale", "Summer sale", "clean"]]]
    ]);

    const live = await ok(t.call(dev, "documents.publish", { type: "post", id: doc.id }));
    expect(live).toMatchObject({ status: "published", publishedVer: 2, pending: [], published: { title: "Summer sale", seo: { description: "Bob's" } } });
    expect((await ok(t.call(dev, "documents.changes", { type: "post", id: doc.id }))).branches).toEqual([]);
  });

  test("two people changing one field conflict until the publisher chooses", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    await edit(bob, doc.id, { title: "Winter sale", seo: { description: "Bob's" } });

    const refused = await t.call(dev, "documents.publish", { type: "post", id: doc.id });
    expect(refused.status).toBe(409);
    expect(refused.body.data.conflicts).toEqual([{ group: "title", status: "conflict", owners: ["bob", "alice"], paths: ["title", "title"] }]);

    const live = await ok(t.call(dev, "documents.publish", { type: "post", id: doc.id, resolve: [{ group: "title", use: "alice" }] }));
    expect(live.published).toMatchObject({ title: "Summer sale", seo: { description: "Bob's" } });
    // Both sides were settled, so nothing's left pending.
    expect(live.pending).toEqual([]);
  });

  test("publishing some branches leaves the others pending, checked against the new version", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    await edit(bob, doc.id, { title: "Winter sale" });
    const live = await ok(t.call(dev, "documents.publish", { type: "post", id: doc.id, branches: ["alice"] }));
    expect(live.published.title).toBe("Summer sale");
    expect(live.pending.map((p: any) => p.owner)).toEqual(["bob"]);
    const [branch] = (await ok(t.call(dev, "documents.changes", { type: "post", id: doc.id }))).branches;
    expect(branch.changes).toMatchObject([{ path: "title", status: "stale", live: "Summer sale", after: "Winter sale" }]);
  });

  test("skipped changes stay on the branch, rebased onto what was published", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale", seo: { description: "Alice's" } });
    const live = await ok(t.call(bob, "documents.publish", { type: "post", id: doc.id, skip: [{ owner: "alice", path: "seo.description" }] }));
    expect(live.published).toMatchObject({ title: "Summer sale", seo: { description: "Old" } });
    const [branch] = (await ok(t.call(dev, "documents.changes", { type: "post", id: doc.id }))).branches;
    expect(branch).toMatchObject({ owner: "alice", baseVer: 2, changes: [{ path: "seo.description", before: "Old", after: "Alice's", status: "clean" }] });
  });

  test("publish: true on a save publishes only your changes", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    const mine = await ok(t.call(bob, "documents.get", { type: "post", id: doc.id }));
    const live = await ok(t.call(bob, "documents.update", { type: "post", id: doc.id, data: { ...mine.draft, seo: { description: "Bob's" } }, publish: true }));
    expect(live.published).toMatchObject({ title: "Spring sale", seo: { description: "Bob's" } });
    expect(live.pending.map((p: any) => p.owner)).toEqual(["alice"]);
  });

  test("saving the live copy back leaves no branch", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    const back = await edit(alice, doc.id, { title: "Spring sale" });
    expect(back).toMatchObject({ status: "published", mine: false, pending: [] });
  });

  test("your other tab's save is a conflict; other people's saves aren't", async () => {
    const doc = await published();
    const read = await ok(t.call(alice, "documents.get", { type: "post", id: doc.id }));
    await edit(bob, doc.id, { title: "Bob's" });
    await ok(t.call(alice, "documents.update", { type: "post", id: doc.id, data: { ...read.draft, title: "First tab" }, baseUpdatedAt: read.updatedAt }));
    const second = await t.call(alice, "documents.update", { type: "post", id: doc.id, data: { ...read.draft, title: "Second tab" }, baseUpdatedAt: read.updatedAt });
    expect(second.status).toBe(409);
  });

  test("changes are based on the version you read, not on one published since", async () => {
    const doc = await published();
    const read = await ok(t.call(alice, "documents.get", { type: "post", id: doc.id }));
    await edit(bob, doc.id, { seo: { description: "Bob's" } });
    await ok(t.call(bob, "documents.publish", { type: "post", id: doc.id }));
    await ok(t.call(alice, "documents.update", { type: "post", id: doc.id, data: { ...read.draft, title: "Summer sale" }, baseVer: read.baseVer }));
    const [branch] = (await ok(t.call(dev, "documents.changes", { type: "post", id: doc.id }))).branches;
    // Alice's copy still has the old description, but she didn't change it, so it isn't hers to publish.
    expect(branch.changes.map((c: any) => c.path)).toEqual(["title"]);
    const live = await ok(t.call(dev, "documents.publish", { type: "post", id: doc.id }));
    expect(live.published).toMatchObject({ title: "Summer sale", seo: { description: "Bob's" } });
  });

  test("discarding: your own changes, or someone else's with publish permission", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    await edit(bob, doc.id, { title: "Winter sale" });
    expect((await t.call(alice, "documents.discardChanges", { type: "post", id: doc.id, owner: "bob" })).status).toBe(403);
    await ok(t.call(bob, "documents.discardChanges", { type: "post", id: doc.id, owner: "alice" }));
    const left = await ok(t.call(bob, "documents.discardChanges", { type: "post", id: doc.id }));
    expect(left).toMatchObject({ status: "published", pending: [], draft: { title: "Spring sale" } });
  });

  test("before the first publish, others start from the newest copy, and the last copy can't be discarded", async () => {
    const created = await ok(t.call(alice, "documents.create", { type: "post", data: post }));
    expect(created).toMatchObject({ status: "draft", mine: true });
    const asBob = await ok(t.call(bob, "documents.get", { type: "post", id: created.id }));
    expect(asBob).toMatchObject({ mine: false, draft: { title: "Spring sale" } });
    await edit(bob, created.id, { seo: { description: "Bob's" } });
    const changes = await ok(t.call(dev, "documents.changes", { type: "post", id: created.id }));
    expect(changes.branches.find((b: any) => b.owner === "bob").changes.map((c: any) => c.path)).toEqual(["seo.description"]);
    const live = await ok(t.call(dev, "documents.publish", { type: "post", id: created.id }));
    expect(live.published).toMatchObject({ title: "Spring sale", seo: { description: "Bob's" } });

    const lonely = await ok(t.call(alice, "documents.create", { type: "post", data: { ...post, slug: "other" } }));
    expect((await t.call(alice, "documents.discardChanges", { type: "post", id: lonely.id })).status).toBe(409);
  });

  test("lists, drafts queries and search see each reader's copy", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    async function list(token: string) {
      return (await ok(t.call(token, "documents.list", { type: "post" }))).docs.map((d: any) => [d.title, d.$meta.status]);
    }
    expect(await list(alice)).toEqual([["Summer sale", "changed"]]);
    expect(await list(bob)).toEqual([["Spring sale", "changed"]]);
    const found = await ok(t.call(bob, "documents.search", { query: "summer" }));
    expect(found.results.map((r: any) => r.id)).toEqual([doc.id]);
  });

  test("a scheduled publish takes the selection made when scheduling", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    await edit(bob, doc.id, { title: "Winter sale", seo: { description: "Bob's" } });
    const runAt = new Date(Date.now() + 60 * 60 * 1000);
    await ok(t.call(dev, "documents.schedule", { type: "post", id: doc.id, action: "publish", runAt: runAt.toISOString(), branches: ["bob"], skip: [{ owner: "bob", path: "title" }] }));
    // Edits after scheduling aren't included.
    await edit(bob, doc.id, { seo: { description: "Later" } });
    await t.vibe.scheduled({ scheduledTime: runAt.getTime() + 1000, cron: "* * * * *" } as never, t.env, ctx);
    const after = await ok(t.call(dev, "documents.get", { type: "post", id: doc.id }));
    expect(after.published).toMatchObject({ title: "Spring sale", seo: { description: "Bob's" } });
    // Alice's and Bob's unscheduled changes are still pending.
    expect(after.pending.map((p: any) => p.owner).sort()).toEqual(["alice", "bob"]);
    const refused = await t.call(dev, "documents.schedule", { type: "post", id: doc.id, action: "publish", runAt: runAt.toISOString() });
    expect(refused.status).toBe(409);
  });

  test("unpublishing keeps something to edit", async () => {
    const doc = await published();
    const off = await ok(t.call(dev, "documents.unpublish", { type: "post", id: doc.id }));
    expect(off).toMatchObject({ status: "draft", draft: { title: "Spring sale" } });
    const again = await ok(t.call(dev, "documents.publish", { type: "post", id: doc.id }));
    expect(again).toMatchObject({ status: "published", published: { title: "Spring sale" }, pending: [] });
  });

  test("deleting and restoring brings the branches back", async () => {
    const doc = await published();
    await edit(alice, doc.id, { title: "Summer sale" });
    const { trash } = await ok(t.call(dev, "documents.delete", { type: "post", id: doc.id }));
    await ok(t.call(dev, "trash.restore", { id: trash }));
    const back = await ok(t.call(alice, "documents.get", { type: "post", id: doc.id }));
    expect(back).toMatchObject({ mine: true, draft: { title: "Summer sale" }, published: { title: "Spring sale" } });
  });
});

describe("migration", () => {
  test("drafts that differ from live become their last editor's branch", async () => {
    const db = createD1({ roles });
    // The database as 0.2.x left it: the first three migrations, and drafts in vibe_documents.
    for(const migration of migrations.slice(0, 3)) for(const sql of migration.statements) db.sqlite.run(sql);
    db.sqlite.run("CREATE TABLE vibe_migrations (tag TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for(const migration of migrations.slice(0, 3)) db.sqlite.query("INSERT INTO vibe_migrations VALUES (?, 0)").run(migration.tag);
    db.sqlite.run("CREATE INDEX vibe_idx_post_slug_d ON vibe_documents (json_extract(draft, '$.\"slug\"')) WHERE type = 'post'");
    const live = JSON.stringify(post);
    const insert = db.sqlite.query("INSERT INTO vibe_documents (id, type, locale, draft, published, published_ver, schema_hash, created_at, updated_at, published_at, updated_by) VALUES (?, 'post', 'en', ?, ?, ?, 'x', 1, 2, ?, ?)");
    insert.run("same", live, live, 1, 1, "alice");
    insert.run("edited", JSON.stringify({ ...post, slug: "edited", title: "Summer sale" }), JSON.stringify({ ...post, slug: "edited" }), 1, 1, "alice");
    insert.run("new", JSON.stringify({ ...post, slug: "new" }), null, null, null, null);

    t = setup(db);
    dev = await t.token({ sub: "dev", roles: ["dev"] });
    const rows = db.sqlite.query("SELECT id, owner, base_ver FROM vibe_branches ORDER BY id").all();
    expect(rows).toEqual([{ id: "edited", owner: "alice", base_ver: 1 }, { id: "new", owner: "system", base_ver: null }]);
    const columns = (db.sqlite.query("PRAGMA table_info(vibe_documents)").all() as Array<{ name: string }>).map(c => c.name);
    expect(columns).not.toContain("draft");

    const changes = await ok(t.call(dev, "documents.changes", { type: "post", id: "edited" }));
    expect(changes.branches[0].changes.map((c: any) => [c.path, c.after])).toEqual([["title", "Summer sale"]]);
    expect((await ok(t.call(dev, "documents.search", { query: "summer" }))).results.map((r: any) => r.id)).toEqual(["edited"]);
  });
});
