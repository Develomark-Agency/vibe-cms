import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createActionClient, httpCaller, type CoreActions } from "../src/actions/index.ts";
import { folderStore } from "../src/backups/fs.ts";
import { planRestore, restoreSnapshot, takeSnapshot, verifyRestore, type BackupStore } from "../src/backups/index.ts";
import { issueSession } from "../src/handler/auth.ts";
import { createHandler } from "../src/handler/index.ts";
import { defineConfig } from "../src/index.ts";
import v from "../src/schema/index.ts";
import { createD1, createR2, ctx } from "./helpers.ts";

/**
 * A content type removed from the config while it still has documents: the site's database keeps
 * them, and nothing in the CMS defines them any more.
 */

const page = { schema: v.object({ title: v.text({ min: 1 }) }) };
const section = { schema: v.object({ heading: v.text({ min: 1 }) }) };
const banner = { schema: v.object({ text: v.text({ min: 1 }) }) };
const before = defineConfig({ locales: ["en", "fr"], collections: { page, section, banner } });
const after = defineConfig({ locales: ["en", "fr"], collections: { page } });

/** One database and bucket, served with whichever config is deployed. */
function site(origin: string, roles?: Record<string, never>) {
  const env = { DB: createD1(roles ? { roles } : {}), MEDIA: createR2() };
  const handlers = new Map<object, ReturnType<typeof createHandler>>();
  function vibe(config: typeof before | typeof after) {
    if(!handlers.has(config)) handlers.set(config, createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) }));
    return handlers.get(config)!;
  }
  return { origin, env, vibe, config: before as typeof before | typeof after };
}

type Site = ReturnType<typeof site>;
let sites: Site[];

const network: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const target = sites.find(s => request.url.startsWith(s.origin));
  if(!target) throw new TypeError(`No site at ${request.url}`);
  return target.vibe(target.config).handle(request, target.env, ctx);
}) as typeof fetch;

async function connect(target: Site, session?: { sub: string, roles: string[] }) {
  let token: string;
  if(session) {
    await network(`${target.origin}/_vibe/api/info`);
    const siteId = (target.env.DB.sqlite.query("SELECT value FROM vibe_meta WHERE key = 'site_id'").get() as { value: string }).value;
    token = (await issueSession(target.env.DB, session, siteId, target.origin)).token;
  } else {
    const response = await network(`${target.origin}/_vibe/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) });
    token = ((await response.json()) as { token: string }).token;
  }
  const call = httpCaller({ url: target.origin, token, fetch: network });
  return { call, actions: createActionClient<CoreActions>(call) };
}

function rows(target: Site, table: string, where = "1") {
  return (target.env.DB.sqlite.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

/**
 * Pages to keep, and sections and banners that the config then drops: published with history, an
 * unpublished edit, a translation, a schedule and a trashed one.
 */
async function fill(target: Site) {
  const { actions } = await connect(target);
  const keep = await actions.documents.create({ type: "page", data: { title: "Home" }, publish: true });
  const hero = await actions.documents.create({ type: "section", data: { heading: "Welcome" }, publish: true });
  await actions.documents.update({ type: "section", id: hero.id, data: { heading: "Welcome back" } });
  await actions.documents.publish({ type: "section", id: hero.id });
  await actions.documents.update({ type: "section", id: hero.id, data: { heading: "Unpublished edit" } });
  await actions.documents.update({ type: "section", id: hero.id, locale: "fr", data: { heading: "Bienvenue" } });
  await actions.documents.schedule({ type: "section", id: hero.id, action: "unpublish", runAt: new Date(Date.now() + 86_400_000).toISOString() });
  const old = await actions.documents.create({ type: "section", data: { heading: "Old" }, publish: true });
  await actions.documents.delete({ type: "section", id: old.id });
  await actions.documents.create({ type: "banner", data: { text: "Sale" }, publish: true });
  // The types go from the config, as when they're removed and the site is deployed again.
  target.config = after;
  return { keep, hero, old };
}

let a: Site;
let b: Site;
let dir: string;
let store: BackupStore;

beforeEach(async () => {
  a = site("https://a.test", { editor: { page: ["read", "write", "delete"] } } as never);
  b = site("https://b.test");
  sites = [a, b];
  dir = await mkdtemp(path.join(tmpdir(), "vibe-unknown-"));
  store = folderStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("documents.purgeUnknown", () => {
  test("a dry run lists each removed type's documents, live and trashed, and deletes nothing", async () => {
    await fill(a);
    const { actions } = await connect(a);
    const listed = await actions.documents.purgeUnknown({ dryRun: true });
    expect(listed).toEqual({
      purged: false,
      types: [
        { type: "banner", documents: 1, translations: 1, trashed: 0 },
        { type: "section", documents: 1, translations: 2, trashed: 1 }
      ]
    });
    expect(rows(a, "vibe_documents", "type = 'section'")).toBe(2);
  });

  test("purging deletes the documents with their versions, branches, schedules, search rows and trash entries", async () => {
    const { keep, hero, old } = await fill(a);
    expect(rows(a, "vibe_versions", `id IN ('${hero.id}', '${old.id}')`)).toBeGreaterThan(0);
    expect(rows(a, "vibe_branches", `id = '${hero.id}'`)).toBeGreaterThan(0);
    expect(rows(a, "vibe_schedules", `id = '${hero.id}'`)).toBe(1);
    expect(rows(a, "vibe_search", `id = '${hero.id}'`)).toBeGreaterThan(0);

    const { actions } = await connect(a);
    const result = await actions.documents.purgeUnknown({});
    expect(result.purged).toBe(true);
    expect(result.types.map(t => t.type)).toEqual(["banner", "section"]);

    for(const table of ["vibe_documents", "vibe_versions", "vibe_branches", "vibe_schedules", "vibe_search"]) {
      expect(rows(a, table, `id IN ('${hero.id}', '${old.id}')`)).toBe(0);
    }
    expect(rows(a, "vibe_documents", "type != 'page'")).toBe(0);
    expect(rows(a, "vibe_trash", "kind = 'document'")).toBe(0);
    // What the config still defines is untouched.
    expect((await actions.documents.get({ type: "page", id: keep.id })).id).toBe(keep.id);
    expect(rows(a, "vibe_versions", `id = '${keep.id}'`)).toBe(1);
    expect((await actions.documents.purgeUnknown({ dryRun: true })).types).toEqual([]);
  });

  test("`type` purges only that removed type", async () => {
    await fill(a);
    const { actions } = await connect(a);
    const result = await actions.documents.purgeUnknown({ type: "banner" });
    expect(result.types.map(t => t.type)).toEqual(["banner"]);
    expect(rows(a, "vibe_documents", "type = 'banner'")).toBe(0);
    expect(rows(a, "vibe_documents", "type = 'section'")).toBe(2);
  });

  test("a type the config still defines, or one with no documents, is refused", async () => {
    await fill(a);
    const { actions } = await connect(a);
    await expect(actions.documents.purgeUnknown({ type: "page" })).rejects.toThrow("still a content type");
    await expect(actions.documents.purgeUnknown({ type: "nothing" })).rejects.toThrow("no documents of type");
    expect(rows(a, "vibe_documents", "type = 'page'")).toBe(1);
  });

  test("needs manageTrash", async () => {
    await fill(a);
    const { actions } = await connect(a, { sub: "u1", roles: ["editor"] });
    await expect(actions.documents.purgeUnknown({ dryRun: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows(a, "vibe_documents", "type = 'section'")).toBe(2);
  });
});

describe("import with skipUnknownTypes", () => {
  /** Exported as in the issue: after the types left the config, which doesn't stop them being exported. */
  async function snapshotOfA() {
    const source = await connect(a);
    const taken = await takeSnapshot({ call: source.call, store, fetch: network });
    return taken.path;
  }

  test("a snapshot with types the site doesn't define is refused, and names the way out", async () => {
    await fill(a);
    const snapshot = await snapshotOfA();
    b.config = after;
    const target = await connect(b);
    const plan = await planRestore({ call: target.call, store, fetch: network, path: snapshot });
    expect(plan.check.ok).toBe(false);
    expect(plan.check.problems.join("\n")).toContain("--skip-unknown-types");
  });

  test("skipping them imports everything else, and says what was left out", async () => {
    const { keep } = await fill(a);
    const snapshot = await snapshotOfA();
    b.config = after;
    const target = await connect(b);

    const plan = await planRestore({ call: target.call, store, fetch: network, path: snapshot, skipUnknownTypes: true });
    expect(plan.check.ok).toBe(true);
    expect(plan.check.warnings.join("\n")).toContain("\"section\" documents are left out");

    const result = await restoreSnapshot({ call: target.call, store, fetch: network, path: snapshot, skipUnknownTypes: true });
    expect(result.skipped).toMatchObject({ documents: 3, trash: 1, schedules: 1 });
    expect(result.skipped.versions).toBeGreaterThan(0);
    expect(result.skipped.branches).toBeGreaterThan(0);

    expect(rows(b, "vibe_documents")).toBe(1);
    expect(rows(b, "vibe_documents", `id = '${keep.id}'`)).toBe(1);
    expect(rows(b, "vibe_versions", `id != '${keep.id}'`)).toBe(0);
    expect(rows(b, "vibe_branches", `id != '${keep.id}'`)).toBe(0);
    expect(rows(b, "vibe_trash", "kind = 'document'")).toBe(0);
    // The left-out rows aren't reported as differences.
    expect(await verifyRestore({ call: target.call, store, fetch: network, path: snapshot, skipped: result.skipped })).toEqual({ ok: true, differences: [] });
  });

  test("without anything to leave out, skipping changes nothing", async () => {
    await fill(a);
    await (await connect(a)).actions.documents.purgeUnknown({});
    const snapshot = await snapshotOfA();
    const target = await connect(b);
    const result = await restoreSnapshot({ call: target.call, store, fetch: network, path: snapshot, skipUnknownTypes: true });
    expect(Object.values(result.skipped).every(n => n === 0)).toBe(true);
    expect(rows(b, "vibe_documents")).toBe(1);
  });
});
