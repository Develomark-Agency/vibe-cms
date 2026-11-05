import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createActionClient, httpCaller, type CoreActions } from "../src/actions/index.ts";
import { folderStore } from "../src/backups/fs.ts";
import { BackupError, listSnapshots, packSnapshot, planRestore, restoreSnapshot, takeSnapshot, unpackSnapshot, verifyRestore, type BackupStore } from "../src/backups/index.ts";
import { can } from "../src/handler/auth.ts";
import { UPLOAD_LIMITS } from "../src/handler/backups.ts";
import { createHandler } from "../src/handler/index.ts";
import { config } from "./fixture.ts";
import { createD1, createR2, ctx, png } from "./helpers.ts";

/** A site reachable at its own origin, in process. */
function site(origin: string) {
  const env = { DB: createD1(), MEDIA: createR2() };
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof env) => ({ db: e.DB, storage: e.MEDIA }) });
  return { origin, env, vibe };
}

type Site = ReturnType<typeof site>;

let sites: Site[];
let requests: string[];
/** Set by a test to make the network fail. */
let breakWhen: ((url: string, init?: RequestInit) => boolean) | null;

const network: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  requests.push(`${request.method} ${request.url}`);
  if(breakWhen?.(request.url, init)) throw new TypeError("fetch failed");
  const target = sites.find(s => request.url.startsWith(s.origin));
  if(!target) throw new TypeError(`No site at ${request.url}`);
  return target.vibe.handle(request, target.env, ctx);
}) as typeof fetch;

async function connect(target: Site) {
  const response = await network(`${target.origin}/_vibe/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) });
  const { token } = await response.json() as { token: string };
  const call = httpCaller({ url: target.origin, token, fetch: network });
  return { call, actions: createActionClient<CoreActions>(call) };
}

let dir: string;
let store: BackupStore;
let a: Site;
let b: Site;

beforeEach(async () => {
  a = site("https://a.test");
  b = site("https://b.test");
  sites = [a, b];
  requests = [];
  breakWhen = null;
  dir = await mkdtemp(path.join(tmpdir(), "vibe-backups-"));
  store = folderStore(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  UPLOAD_LIMITS.single = 90 * 1024 * 1024;
  UPLOAD_LIMITS.part = 50 * 1024 * 1024;
});

/** A site with published and draft content, a version history, a translation, a schedule, media, a trashed file and settings. */
async function fill(target: Site) {
  const { actions } = await connect(target);
  const author = await actions.documents.create({ type: "author", data: { name: "Ada Lovelace" }, publish: true });
  const cover = await actions.assets.upload({ file: new File([png(400, 300)], "cover.png", { type: "image/png" }), folder: "covers" });
  const spare = await actions.assets.upload({ file: new File([png(200, 200)], "spare.png", { type: "image/png" }) });
  await actions.assets.delete({ id: spare.id });
  const post = await actions.documents.create({
    type: "post",
    data: { title: "Hello analytical engine", slug: "hello", tags: ["math"], layout: "default", author: author.id, cover: { asset: cover.id, alt: "A cover" } },
    publish: true
  });
  await actions.documents.update({ type: "post", id: post.id, data: { ...post.draft, title: "Hello again, analytical engine" } });
  await actions.documents.publish({ type: "post", id: post.id });
  await actions.documents.update({ type: "post", id: post.id, data: { ...post.draft, title: "Unpublished draft edit here" } });
  await actions.documents.update({ type: "post", id: post.id, locale: "fr", data: { ...post.draft, title: "Bonjour la machine" } });
  await actions.documents.schedule({ type: "post", id: post.id, action: "unpublish", runAt: new Date(Date.now() + 86_400_000).toISOString() });
  await actions.site.update({ name: "Site A", accent: "#6d28d9", icon: cover.id });
  return { author, cover, post, spare };
}

describe("snapshots", () => {
  test("a snapshot restores into another site exactly, files and all", async () => {
    const { cover, post, spare } = await fill(a);
    const source = await connect(a);
    const taken = await takeSnapshot({ call: source.call, store, fetch: network });
    expect(taken.warnings).toEqual([]);
    expect(taken.manifest.tables).toMatchObject({ documents: 3, versions: 3, schedules: 1, assets: 1, trash: 1, settings: 1 });
    expect(taken.manifest.files.count).toBe(2);

    const target = await connect(b);
    await target.actions.documents.create({ type: "author", data: { name: "Someone who'll be replaced" }, publish: true });
    const plan = await planRestore({ call: target.call, store, path: taken.path });
    expect(plan.check.ok).toBe(true);
    expect(plan.check.warnings[0]).toContain("another site");
    expect(plan.tables.documents).toEqual({ now: 1, after: 3 });

    const result = await restoreSnapshot({ call: target.call, store, fetch: network, path: taken.path });
    expect(result.files).toEqual({ uploaded: 2, present: 0 });
    expect((await verifyRestore({ call: target.call, store, path: taken.path })).ok).toBe(true);

    // Drafts, the published copy, translations and history come back as they were.
    const restored = await target.actions.documents.get({ type: "post", id: post.id });
    expect(restored.draft!.title).toBe("Unpublished draft edit here");
    expect(restored.published!.title).toBe("Hello again, analytical engine");
    expect((await target.actions.documents.get({ type: "post", id: post.id, locale: "fr" })).draft!.title).toBe("Bonjour la machine");
    expect((await target.actions.documents.versions({ type: "post", id: post.id })).versions).toHaveLength(2);
    expect((await target.actions.documents.list({ type: "author" })).total).toBe(1);

    // Settings and media: served from the new site, the trashed file restorable there.
    const settings = await target.actions.site.get();
    expect(settings).toMatchObject({ name: "Site A", accent: "#6d28d9", icon: { id: cover.id } });
    expect(settings.id).not.toBe((await source.actions.site.get()).id);
    const image = await network(`${b.origin}/_vibe/media/${cover.id}.png`);
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png(400, 300));
    const trash = await target.actions.trash.list();
    expect(trash.items.map((item: { label: string }) => item.label)).toEqual([spare.filename]);
    await target.actions.trash.restore({ id: trash.items[0]!.id });
    expect((await network(`${b.origin}/_vibe/media/${spare.id}.png`)).status).toBe(200);

    // The search index follows the restored documents.
    expect((await target.actions.documents.search({ query: "unpublished" })).results.map((r: { id: string }) => r.id)).toEqual([post.id]);
    expect((await target.actions.documents.search({ query: "replaced" })).results).toEqual([]);
  });

  test("later snapshots skip files they already have", async () => {
    await fill(a);
    const { call } = await connect(a);
    await takeSnapshot({ call, store, fetch: network });
    function downloads() {
      return requests.filter(r => r.startsWith("GET") && r.includes("/api/backups/files/")).length;
    }
    expect(downloads()).toBe(2);
    await new Promise(resolve => setTimeout(resolve, 5));
    await takeSnapshot({ call, store, fetch: network });
    expect(downloads()).toBe(2);
    const listed = await listSnapshots(store, (await connect(a).then(c => c.actions.site.get())).id);
    expect(listed).toHaveLength(2);
  });

  test("an interrupted snapshot never counts as finished", async () => {
    await fill(a);
    const { call } = await connect(a);
    breakWhen = url => url.includes("/api/backups/files/");
    await expect(takeSnapshot({ call, store, fetch: network, attempts: 2 })).rejects.toThrow("fetch failed");
    expect(await listSnapshots(store, (await connect(a).then(c => c.actions.site.get())).id)).toEqual([]);
  }, 10_000);
});

describe("restores", () => {
  test("a failed restore leaves the site as it was, and running it again resumes it", async () => {
    await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const target = await connect(b);
    const mine = await target.actions.documents.create({ type: "author", data: { name: "Still here" }, publish: true });

    breakWhen = (url, init) => init?.method === "PUT" && url.includes("/api/backups/files/");
    await expect(restoreSnapshot({ call: target.call, store, fetch: network, path: taken.path, attempts: 1 })).rejects.toThrow("fetch failed");
    expect((await target.actions.documents.list({ type: "author" })).docs.map((d: { id: string }) => d.id)).toEqual([mine.id]);
    expect((await target.actions.backups.restoreStatus()).restore).toMatchObject({ staged: { documents: 3 } });

    breakWhen = null;
    const again = await restoreSnapshot({ call: target.call, store, fetch: network, path: taken.path });
    expect(again.resumed).toBe(true);
    expect((await target.actions.documents.list({ type: "author" })).docs.map(d => d.name)).toEqual(["Ada Lovelace"]);
    expect((await target.actions.backups.restoreStatus()).restore).toBeNull();
  }, 10_000);

  test("network errors are retried", async () => {
    await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const target = await connect(b);
    let failures = 2;
    breakWhen = (url, init) => init?.method === "PUT" && failures-- > 0;
    const retries: string[] = [];
    await restoreSnapshot({ call: target.call, store, fetch: network, path: taken.path, onProgress: p => p.step === "retry" && retries.push(p.what) });
    expect(retries).toHaveLength(2);
    expect((await verifyRestore({ call: target.call, store, path: taken.path })).ok).toBe(true);
  }, 20_000);

  test("large files go up in parts", async () => {
    const { actions } = await connect(a);
    const bytes = new Uint8Array(2500).map((_, i) => i % 251);
    const file = await actions.assets.upload({ file: new File([bytes], "notes.txt", { type: "text/plain" }) });
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    UPLOAD_LIMITS.single = 1000;
    UPLOAD_LIMITS.part = 1000;
    const target = await connect(b);
    await restoreSnapshot({ call: target.call, store, fetch: network, path: taken.path });
    expect(requests.filter(r => r.startsWith("PUT") && r.includes("&part=")).length).toBe(3);
    expect(b.env.MEDIA.objects.get(`assets/${file.id}`)!.data).toEqual(bytes);
  });

  test("a commit refuses missing rows or files, and changes nothing", async () => {
    await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const { actions } = await connect(b);
    const { restoreId } = await actions.backups.restoreBegin({ manifest: taken.manifest });
    await expect(actions.backups.restoreCommit({ restoreId, expected: taken.manifest.tables })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("documents has 0 of 3 rows") });
    const assets = await (await connect(a)).actions.backups.export({ table: "assets" });
    await actions.backups.restoreRows({ restoreId, table: "assets", rows: assets.rows });
    await expect(actions.backups.restoreCommit({ restoreId, expected: { assets: 1 } })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("weren't uploaded") });
    await actions.backups.restoreCancel({ restoreId });
    expect((await actions.backups.restoreStatus()).restore).toBeNull();
  });

  test("snapshots of content types the site doesn't define can't be restored", async () => {
    await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const manifest = { ...taken.manifest, types: { ...taken.manifest.types, product: { hash: "x", documents: 4 } } };
    const { actions } = await connect(b);
    const check = await actions.backups.check({ manifest });
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain("\"product\"");
    await expect(actions.backups.restoreBegin({ manifest })).rejects.toMatchObject({ code: "UNPROCESSABLE_CONTENT" });
    expect((await actions.backups.restoreStatus()).restore).toBeNull();
  });

  test("only one restore runs at a time", async () => {
    await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const { actions } = await connect(b);
    await actions.backups.restoreBegin({ manifest: taken.manifest });
    await expect(actions.backups.restoreBegin({ manifest: taken.manifest })).rejects.toMatchObject({ code: "CONFLICT" });
    await actions.backups.restoreBegin({ manifest: taken.manifest, force: true });
  });
});

describe("access", () => {
  test("backups need their own permission", () => {
    expect(can({ config, roles: { map: config.permissions?.roles ?? {} } }, { sub: "x", roles: ["editor"] }, { action: "read", scope: "backups" })).toBe(false);
    expect(can({ config, roles: { map: { ops: { backups: true } } } }, { sub: "x", roles: ["ops"] }, { action: "write", scope: "backups" })).toBe(true);
  });

  test("transfer links are signed and expire", async () => {
    await fill(a);
    const { actions } = await connect(a);
    const { files } = await actions.backups.files({});
    const url = new URL(files[0]!.url!);
    expect((await network(url)).status).toBe(200);
    const tampered = new URL(url);
    tampered.pathname = tampered.pathname.replace(/assets\/[^/]+$/, "assets/other");
    expect((await network(tampered)).status).toBe(403);
    const expired = new URL(url);
    expired.searchParams.set("exp", "1");
    expect((await network(expired)).status).toBe(403);
  });

  test("snapshots read from a missing folder fail clearly", async () => {
    await expect(planRestore({ call: (await connect(b)).call, store, path: "snapshots/nope/1" })).rejects.toBeInstanceOf(BackupError);
  });
});

describe(".vibe files", () => {
  test("a snapshot packs into one file, opens with tar, and restores from it", async () => {
    const { cover, post } = await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const file = path.join(dir, "site.vibe");
    await Bun.write(file, new Response(await packSnapshot(store, taken.path)));

    // Plain tar reads it: manifest first, then tables, the file list and the files.
    const listing = Bun.spawnSync(["tar", "-tzf", file]).stdout.toString().trim().split("\n");
    expect(listing.slice(0, 3)).toEqual(["manifest.json", "complete.json", "tables/documents.jsonl"]);
    expect(listing.filter(name => name.startsWith("files/"))).toHaveLength(2);

    const elsewhere = folderStore(path.join(dir, "elsewhere"));
    const unpacked = await unpackSnapshot(Bun.file(file).stream(), elsewhere);
    expect(unpacked.manifest.tables).toEqual(taken.manifest.tables);
    const target = await connect(b);
    await restoreSnapshot({ call: target.call, store: elsewhere, fetch: network, path: unpacked.path });
    expect((await target.actions.documents.get({ type: "post", id: post.id })).draft!.title).toBe("Unpublished draft edit here");
    expect(new Uint8Array(await (await network(`${b.origin}/_vibe/media/${cover.id}.png`)).arrayBuffer())).toEqual(png(400, 300));
  });

  test("a damaged or foreign file is refused before anything changes", async () => {
    await fill(a);
    const taken = await takeSnapshot({ call: (await connect(a)).call, store, fetch: network });
    const whole = new Uint8Array(await new Response(await packSnapshot(store, taken.path)).arrayBuffer());
    const truncated = new Response(whole.slice(0, Math.floor(whole.length / 2))).body!;
    await expect(unpackSnapshot(truncated, folderStore(path.join(dir, "x")))).rejects.toThrow();
    const notTar = new Response(new Response("hello").body!.pipeThrough(new CompressionStream("gzip"))).body!;
    await expect(unpackSnapshot(notTar, folderStore(path.join(dir, "y")))).rejects.toThrow("isn't a .vibe file");
    expect((await listSnapshots(folderStore(path.join(dir, "x")), taken.manifest.siteId))).toEqual([]);
  });
});
