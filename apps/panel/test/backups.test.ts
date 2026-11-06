import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { defineConfig } from "vibe-cms";
import { createActionClient, httpCaller, type CoreActions } from "vibe-cms/actions";
import { createHandler } from "vibe-cms/handler";
import { unpackSnapshot } from "vibe-cms/backups";
import type { SiteBackups } from "vibe-cms/panel";
import v from "vibe-cms/schema";
import { createD1, createR2 } from "../../../packages/vibe-cms/test/helpers.ts";
import { DEFAULT_POLICY, processBackups, retained } from "../src/server/backups.ts";
import { backupToken } from "../src/server/hub.ts";
import { handle } from "../src/server/index.ts";
import { assignRoles, env, idp, installMock, ORG, panel, removeMock, signIn, sites } from "./mock.ts";

/** Enough of an R2 bucket for the archive. */
function bucket() {
  const objects = new Map<string, { data: Uint8Array, uploaded: Date }>();
  function object(key: string, data: Uint8Array, uploaded: Date) {
    return ({
      key,
      size: data.byteLength,
      uploaded,
      body: new Response(data as Uint8Array<ArrayBuffer>).body,
      text: async () => new TextDecoder().decode(data)
    });
  }
  return {
    objects,
    async get(key: string) {
      const o = objects.get(key);
      return o ? object(key, o.data, o.uploaded) : null;
    },
    async head(key: string) {
      const o = objects.get(key);
      return o ? { key, size: o.data.byteLength, uploaded: o.uploaded } : null;
    },
    async put(key: string, value: string | Uint8Array | ReadableStream) {
      const data = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      objects.set(key, { data, uploaded: new Date() });
      return { key, size: data.byteLength };
    },
    async delete(keys: string | string[]) {
      for(const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix = "", delimiter }: { prefix?: string, delimiter?: string }) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const prefixes = new Set<string>();
      const found = [];
      for(const key of keys) {
        const rest = key.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        if(cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
        else found.push({ key, size: objects.get(key)!.data.byteLength, uploaded: objects.get(key)!.uploaded });
      }
      return { objects: found, delimitedPrefixes: [...prefixes], truncated: false };
    }
  };
}

const archive = bucket();

function backupSite(origin: string, allowBackups: boolean) {
  const config = defineConfig({
    backups: allowBackups,
    schemas: { post: v.object({ title: v.text() }) }
  });
  const siteEnv = { DB: createD1({ roles: { editor: { post: ["read", "write", "publish"] }, ops: { post: ["read"], backups: true } } }), MEDIA: createR2(), VIBE_ORG: ORG };
  // Development mode only so the test can seed content with a dev session; panel users still sign in through the hub.
  const vibe = createHandler(config, { dev: true, bindings: (e: typeof siteEnv) => ({ db: e.DB, storage: e.MEDIA }) });
  function handler(request: Request) {
    return vibe.handle(request, siteEnv, { waitUntil() {} });
  }
  sites[origin] = handler;
  async function dev() {
    const response = await handler(new Request(`${origin}/_vibe/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dev: true }) }));
    return createActionClient<CoreActions>(httpCaller({ url: origin, token: (await response.json() as { token: string }).token, fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))) as typeof fetch }));
  }
  return {
    env: siteEnv,
    async seed(titles: string[]) {
      const actions = await dev();
      for(const title of titles) await actions.documents.create({ type: "post", data: { title }, publish: true });
      await actions.assets.upload({ file: new File([new Uint8Array(4096).fill(7)], "notes.txt", { type: "text/plain" }) });
    },
    async titles() {
      return (await vibe.client(siteEnv).query(config.schemas.post).findMany()).map(p => p.title).sort();
    }
  };
}

async function addSite(url: string): Promise<string> {
  const response = await panel("/api/sites", { method: "POST", body: JSON.stringify({ url }) });
  expect(response.status).toBe(201);
  return (await response.json() as { id: string }).id;
}

async function backups(siteId: string): Promise<SiteBackups> {
  return panel(`/api/sites/${siteId}/backups`).then(r => r.json() as Promise<SiteBackups>);
}

let siteC: ReturnType<typeof backupSite>;
let siteD: ReturnType<typeof backupSite>;
let c: string;
let d: string;

beforeAll(async () => {
  installMock();
  env.BACKUPS = archive as unknown as R2Bucket;
  sites["https://panel.test"] = request => handle(request, env);
  siteC = backupSite("https://site-c.test", true);
  siteD = backupSite("https://site-d.test", false);
  await siteC.seed(["First", "Second"]);
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  await signIn();
  c = await addSite("https://site-c.test");
  d = await addSite("https://site-d.test");
});

afterAll(async () => {
  // The panel's database is shared with the other test files.
  const { results } = await env.DB.prepare("SELECT id FROM sites WHERE url IN ('https://site-c.test', 'https://site-d.test', 'https://site-e.test')").all<{ id: string }>();
  for(const { id } of results) await panel(`/api/sites/${id}`, { method: "DELETE" });
  for(const origin of ["https://panel.test", "https://site-c.test", "https://site-d.test", "https://site-e.test"]) delete sites[origin];
  delete env.BACKUPS;
  idp.email = "jane@agency.test";
  idp.sub = "u-jane";
  removeMock();
});

describe("panel backups", () => {
  test("the panel publishes the key sites verify its backup tokens with", async () => {
    const { keys } = await (await panel("/.well-known/jwks.json")).json() as { keys: Array<{ kty: string, alg: string }> };
    expect(keys).toEqual([expect.objectContaining({ kty: "EC", alg: "ES256" })]);
  });

  test("backing up a site that trusts the panel stores a snapshot in the archive", async () => {
    const before = await backups(c);
    expect(before).toMatchObject({ available: true, trusted: true, panel: ORG, policy: null, effective: DEFAULT_POLICY, snapshots: [] });
    expect((await panel(`/api/sites/${c}/backups`, { method: "POST" })).status).toBe(202);
    await processBackups(env, { schedule: false });
    const after = await backups(c);
    expect(after.runs[0]).toMatchObject({ kind: "manual", status: "done", requestedBy: "jane@agency.test" });
    expect(after.snapshots).toEqual([expect.objectContaining({ kind: "manual", documents: 2, files: 1, bytes: 4096 })]);
    expect([...archive.objects.keys()].filter(k => k.startsWith(`files/${c}/`))).toHaveLength(1);
  });

  test("a snapshot downloads as one .vibe file", async () => {
    const [snapshot] = (await backups(c)).snapshots;
    const response = await panel(`/api/backups/download?snapshot=${encodeURIComponent(snapshot!.id)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="site-c-test-.+\.vibe"$/);
    const files = new Map<string, number>();
    const store = {
      readText: async () => null,
      writeText: async () => {},
      has: async (p: string) => files.has(p),
      readFile: async () => null,
      writeFile: async (p: string, body: ReadableStream, size: number) => {
        await new Response(body).arrayBuffer();
        files.set(p, size);
      },
      list: async () => []
    };
    const { manifest } = await unpackSnapshot(response.body!, store);
    expect(manifest.tables.documents).toBe(2);
    expect([...files.values()]).toEqual([4096]);
    expect((await panel("/api/backups/download?snapshot=nope")).status).toBe(404);
  });

  test("a site that doesn't trust the panel fails with how to fix it", async () => {
    const status = await backups(d);
    expect(status.trusted).toBe(false);
    await panel(`/api/sites/${d}/backups`, { method: "POST" });
    await processBackups(env, { schedule: false });
    const [run] = (await backups(d)).runs;
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("backups: true");
  });

  test("a backup token can't do anything but backups", async () => {
    const token = await backupToken(env, c);
    function call(action: string, input: unknown, bearer = token) {
      return sites["https://site-c.test"]!(new Request(`https://site-c.test/_vibe/api/actions/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
        body: JSON.stringify(input)
      }));
    }
    expect((await call("backups.manifest", {})).status).toBe(200);
    expect((await call("documents.list", { type: "post" })).status).toBe(403);
    expect((await call("site.update", { name: "Taken over" })).status).toBe(403);
    // Tokens are for one site, and site D doesn't let the hub back it up.
    expect((await sites["https://site-d.test"]!(new Request("https://site-d.test/_vibe/api/actions/backups.manifest", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await backupToken(env, d)}` },
      body: "{}"
    }))).status).toBe(401);
    expect((await call("backups.manifest", {}, "not-a-token")).status).toBe(401);
  });

  test("restoring needs the site's owners, and brings content back", async () => {
    const [snapshot] = (await backups(c)).snapshots;
    // Someone with only a role on the site can't restore it from the panel.
    await assignRoles(c, "u-ops", ["ops"]);
    idp.email = "ops@agency.test";
    idp.sub = "u-ops";
    await signIn();
    const refused = await panel(`/api/sites/${c}/backups/restore`, { method: "POST", body: JSON.stringify({ snapshot: snapshot!.id }) });
    expect(refused.status).toBe(403);

    await siteC.seed(["Added after the snapshot"]);
    expect(await siteC.titles()).toEqual(["Added after the snapshot", "First", "Second"]);
    idp.email = "jane@agency.test";
    idp.sub = "u-jane";
    await signIn();
    const accepted = await panel(`/api/sites/${c}/backups/restore`, { method: "POST", body: JSON.stringify({ snapshot: snapshot!.id }) });
    expect(accepted.status).toBe(202);
    await processBackups(env, { schedule: false });
    const status = await backups(c);
    expect(status.runs[0]).toMatchObject({ kind: "restore", status: "done", snapshot: snapshot!.id });
    // The site as it was before the restore is kept as a safety snapshot.
    expect(status.snapshots.map(s => s.kind).sort()).toEqual(["manual", "safety"]);
    expect(await siteC.titles()).toEqual(["First", "Second"]);
  });

  test("scheduled snapshots come due at the policy's hour, once a day", async () => {
    const hour = new Date().getUTCHours();
    const fresh = backupSite("https://site-e.test", true);
    await fresh.seed(["Hello"]);
    const e = await addSite("https://site-e.test");
    await panel(`/api/sites/${c}/backups/policy`, { method: "PUT", body: JSON.stringify({ policy: { ...DEFAULT_POLICY, enabled: false } }) });
    await panel(`/api/sites/${e}/backups/policy`, { method: "PUT", body: JSON.stringify({ policy: { ...DEFAULT_POLICY, hour } }) });
    await panel(`/api/sites/${d}/backups/policy`, { method: "PUT", body: JSON.stringify({ policy: { ...DEFAULT_POLICY, enabled: false } }) });
    await processBackups(env);
    await processBackups(env);
    const status = await backups(e);
    expect(status.policy?.hour).toBe(hour);
    expect(status.snapshots).toEqual([expect.objectContaining({ kind: "scheduled", documents: 1 })]);
    expect(status.runs.filter(r => r.kind === "scheduled")).toHaveLength(1);
    expect((await backups(d)).runs.filter(r => r.kind === "scheduled")).toHaveLength(0);
    expect((await backups(c)).runs.filter(r => r.kind === "scheduled")).toHaveLength(0);
  });

  test("a run whose Worker stopped is taken over once its lease lapses", async () => {
    await env.DB.prepare("INSERT INTO backup_runs (id, site_id, kind, status, attempts, next_at, lease_until, created_at) VALUES ('run_stuck', ?, 'manual', 'running', 1, 0, ?, ?)")
      .bind(c, Date.now() - 1000, Date.now()).run();
    await processBackups(env, { schedule: false });
    const run = (await backups(c)).runs.find(r => r.id === "run_stuck");
    expect(run).toMatchObject({ status: "done", attempts: 2 });
  });
});

describe("retention", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 2, 12);
  const daily = Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, taken_at: now - i * DAY, kind: "scheduled" }));

  test("keeps the last two days, then one per day, week and month", () => {
    const keep = retained(daily, { ...DEFAULT_POLICY, keepDaily: 7, keepWeekly: 4, keepMonthly: 3 }, now);
    // 7 days, plus 4 weeks (3 beyond the days), plus 3 months (2 beyond the weeks).
    expect(keep.size).toBeGreaterThanOrEqual(7);
    expect(keep.size).toBeLessThanOrEqual(14);
    expect(keep.has("s0") && keep.has("s1") && keep.has("s6")).toBe(true);
    expect(keep.has("s119")).toBe(false);
  });

  test("safety snapshots stay 30 days whatever the policy", () => {
    const keep = retained([{ id: "safe", taken_at: now - 20 * DAY, kind: "safety" }, { id: "old", taken_at: now - 40 * DAY, kind: "safety" }], { ...DEFAULT_POLICY, keepDaily: 0, keepWeekly: 0, keepMonthly: 0 }, now);
    expect([...keep]).toEqual(["safe"]);
  });
});
