import { httpCaller, type ActionCaller } from "vibe-cms/actions";
import { BackupError, packSnapshot, readSnapshot, restoreSnapshot, takeSnapshot, verifyRestore, type BackupStore, type Progress, type SnapshotFile } from "vibe-cms/backups";
import { fetchDescriptor, PanelError, type BackupPolicy, type PanelSite, type SiteBackups } from "vibe-cms/panel";
import { randomString } from "./oidc.ts";
import { backupToken, codeFor, hubOrg } from "./hub.ts";
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { max } from "drizzle-orm";
import * as t from "./schema.ts";
import type { RunRow, SnapshotRow } from "./schema.ts";
import { db, json, siteById, type Env, type SessionRow } from "./shared.ts";

/**
 * Scheduled backups. The panel holds the policy (when, how many to keep) and the archive
 * (the `BACKUPS` bucket); each site holds the data and decides, with `backups: true` in its
 * config, that its hub may snapshot and restore it.
 *
 * Work is a queue of runs in D1. A run holds a lease it renews while it works; the cron trigger
 * picks up queued runs and runs whose lease lapsed (the Worker was stopped), and the backup runner
 * resumes where it was: tables are read again, files the archive already has aren't, and a
 * restore picks up its staging on the site.
 */

export const DEFAULT_POLICY: BackupPolicy = { enabled: true, hour: 3, keepDaily: 14, keepWeekly: 8, keepMonthly: 12 };

const LEASE = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Safety snapshots (taken before a restore) are kept this long whatever the policy says. */
const SAFETY_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

function apiParts(site: PanelSite) {
  const admin = new URL(site.admin);
  return { url: admin.origin, prefix: admin.pathname.replace(/\/admin\/?$/, "") };
}

/** Calls a site's actions as the panel, with a fresh token whenever the last is near expiry. */
function panelCaller(env: Env, site: PanelSite): ActionCaller {
  let token: { value: string, until: number } | undefined;
  return async (name, input) => {
    if(!token || token.until < Date.now() + 60_000) token = { value: await backupToken(env, site.id), until: Date.now() + 15 * 60_000 };
    return httpCaller({ ...apiParts(site), token: token.value })(name, input);
  };
}

// --- The archive -----------------------------------------------------------------

/** Snapshots in an R2 bucket. Large files stream straight from the site into the bucket. */
export function bucketStore(bucket: R2Bucket): BackupStore {
  return {
    async readText(path) {
      return (await bucket.get(path))?.text() ?? null;
    },
    async writeText(path, text) {
      await bucket.put(path, text);
    },
    async has(path) {
      return (await bucket.head(path)) !== null;
    },
    async readFile(path) {
      const object = await bucket.get(path);
      return object ? { body: object.body as ReadableStream<Uint8Array>, size: object.size } : null;
    },
    async writeFile(path, body, size) {
      // R2 needs the length of a streamed body up front.
      const Fixed = (globalThis as { FixedLengthStream?: new (length: number) => TransformStream }).FixedLengthStream;
      if(Fixed) {
        const sized = new Fixed(size);
        const [put] = await Promise.all([bucket.put(path, sized.readable), body.pipeTo(sized.writable)]);
        if(put?.size !== size) throw new Error(`Stored ${put?.size ?? 0} of ${size} bytes`);
      } else {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        if(bytes.byteLength !== size) throw new Error(`Downloaded ${bytes.byteLength} of ${size} bytes`);
        await bucket.put(path, bytes);
      }
    },
    async list(path) {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: `${path}/`, delimiter: "/", cursor });
        names.push(...page.delimitedPrefixes.map(p => p.slice(path.length + 1).replace(/\/$/, "")));
        names.push(...page.objects.map(o => o.key.slice(path.length + 1)));
        cursor = page.truncated ? page.cursor : undefined;
      } while(cursor);
      return names;
    }
  };
}

async function deletePrefix(bucket: R2Bucket, prefix: string, keep?: (key: string, uploaded: Date) => boolean) {
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor });
    const doomed = page.objects.filter(o => !keep?.(o.key, o.uploaded)).map(o => o.key);
    if(doomed.length) await bucket.delete(doomed);
    cursor = page.truncated ? page.cursor : undefined;
  } while(cursor);
}

// --- Policies ------------------------------------------------------------------------

function cleanPolicy(input: unknown): BackupPolicy {
  const value = (input ?? {}) as Partial<Record<keyof BackupPolicy, unknown>>;
  function count(n: unknown, fallback: number) {
    return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1000 ? n as number : fallback;
  }
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_POLICY.enabled,
    hour: Number.isInteger(value.hour) && (value.hour as number) >= 0 && (value.hour as number) <= 23 ? value.hour as number : DEFAULT_POLICY.hour,
    keepDaily: count(value.keepDaily, DEFAULT_POLICY.keepDaily),
    keepWeekly: count(value.keepWeekly, DEFAULT_POLICY.keepWeekly),
    keepMonthly: count(value.keepMonthly, DEFAULT_POLICY.keepMonthly)
  };
}

async function storedPolicy(env: Env, siteId: string): Promise<BackupPolicy | null> {
  const [row] = await db(env).select({ policy: t.backupPolicies.policy }).from(t.backupPolicies).where(eq(t.backupPolicies.site_id, siteId));
  return row ? cleanPolicy(JSON.parse(row.policy)) : null;
}

export async function defaultPolicy(env: Env): Promise<BackupPolicy> {
  return await storedPolicy(env, "*") ?? DEFAULT_POLICY;
}

async function effectivePolicy(env: Env, siteId: string): Promise<BackupPolicy> {
  return await storedPolicy(env, siteId) ?? defaultPolicy(env);
}

async function savePolicy(env: Env, siteId: string, policy: BackupPolicy | null, user: string) {
  if(policy === null) {
    await db(env).delete(t.backupPolicies).where(eq(t.backupPolicies.site_id, siteId));
    return;
  }
  const row = { policy: JSON.stringify(cleanPolicy(policy)), updated_by: user, updated_at: Date.now() };
  await db(env).insert(t.backupPolicies).values({ site_id: siteId, ...row }).onConflictDoUpdate({ target: t.backupPolicies.site_id, set: row });
}

/** The latest time today's (or yesterday's) scheduled snapshot was due. */
function lastSlot(now: number, hour: number): number {
  const slot = new Date(now);
  slot.setUTCHours(hour, 0, 0, 0);
  return slot.getTime() > now ? slot.getTime() - DAY : slot.getTime();
}

/** Snapshots to keep: the last two days, then one per day, week and month as the policy says. */
export function retained(snapshots: Array<{ id: string, taken_at: number, kind: string }>, policy: BackupPolicy, now: number): Set<string> {
  const keep = new Set<string>();
  const sorted = [...snapshots].sort((a, b) => b.taken_at - a.taken_at);
  for(const s of sorted) {
    if(now - s.taken_at < 2 * DAY) keep.add(s.id);
    if(s.kind === "safety" && now - s.taken_at < SAFETY_DAYS * DAY) keep.add(s.id);
  }
  const regular = sorted.filter(s => s.kind !== "safety");
  const tiers: Array<[number, (t: number) => string]> = [
    [policy.keepDaily, t => new Date(t).toISOString().slice(0, 10)],
    // Weeks from Monday 1970-01-05.
    [policy.keepWeekly, t => String(Math.floor((t - 4 * DAY) / (7 * DAY)))],
    [policy.keepMonthly, t => new Date(t).toISOString().slice(0, 7)]
  ];
  for(const [count, bucket] of tiers) {
    const seen = new Set<string>();
    for(const s of regular) {
      if(seen.size >= count) break;
      const key = bucket(s.taken_at);
      if(seen.has(key)) continue;
      seen.add(key);
      keep.add(s.id);
    }
  }
  return keep;
}

/** Deletes snapshots the policy no longer keeps, then files no remaining snapshot uses. */
async function prune(env: Env, siteId: string) {
  const bucket = env.BACKUPS!;
  const policy = await effectivePolicy(env, siteId);
  const results = await db(env).select({ id: t.backupSnapshots.id, taken_at: t.backupSnapshots.taken_at, kind: t.backupSnapshots.kind })
    .from(t.backupSnapshots).where(eq(t.backupSnapshots.site_id, siteId));
  const keep = retained(results, policy, Date.now());
  const doomed = results.filter(s => !keep.has(s.id));
  for(const s of doomed) {
    await deletePrefix(bucket, `${s.id}/`);
    await db(env).delete(t.backupSnapshots).where(eq(t.backupSnapshots.id, s.id));
  }
  if(!doomed.length) return;
  const store = bucketStore(bucket);
  const used = new Set<string>();
  for(const s of results.filter(s => keep.has(s.id))) {
    for(const file of JSON.parse(await store.readText(`${s.id}/files.json`) ?? "[]") as SnapshotFile[]) used.add(file.object);
  }
  // Files written in the last day may belong to a snapshot that hasn't finished.
  await deletePrefix(bucket, `files/${siteId}/`, (key, uploaded) => used.has(key) || Date.now() - uploaded.getTime() < DAY);
}

// --- Runs ----------------------------------------------------------------------------

async function enqueue(env: Env, siteId: string, kind: RunRow["kind"], options: { snapshot?: string, user?: string } = {}): Promise<string> {
  if(kind !== "restore") {
    // One snapshot at a time: asking again while one is queued or running joins it.
    const [active] = await db(env).select({ id: t.backupRuns.id }).from(t.backupRuns)
      .where(and(eq(t.backupRuns.site_id, siteId), ne(t.backupRuns.kind, "restore"), inArray(t.backupRuns.status, ["queued", "running"])));
    if(active) return active.id;
  } else {
    const [restoring] = await db(env).select({ id: t.backupRuns.id }).from(t.backupRuns)
      .where(and(eq(t.backupRuns.site_id, siteId), eq(t.backupRuns.kind, "restore"), inArray(t.backupRuns.status, ["queued", "running"])));
    if(restoring) throw new PanelError(409, "A restore of this site is already under way");
  }
  const id = `run_${randomString(12)}`;
  await db(env).insert(t.backupRuns).values({
    id,
    site_id: siteId,
    kind,
    snapshot: options.snapshot ?? null,
    status: "queued",
    next_at: Date.now(),
    requested_by: options.user ?? null,
    created_at: Date.now()
  });
  return id;
}

/** Queues the scheduled snapshot of every site whose time has come and has none since. */
async function enqueueDue(env: Env, now: number) {
  const sites = await db(env)
    .select({ id: t.sites.id, last: max(t.backupSnapshots.taken_at) })
    .from(t.sites)
    .leftJoin(t.backupSnapshots, and(eq(t.backupSnapshots.site_id, t.sites.id), inArray(t.backupSnapshots.kind, ["scheduled", "manual"])))
    .groupBy(t.sites.id);
  for(const site of sites) {
    const policy = await effectivePolicy(env, site.id);
    if(!policy.enabled || (site.last ?? 0) >= lastSlot(now, policy.hour)) continue;
    // A run that failed for good waits for the next slot rather than retrying all day.
    const [failed] = await db(env).select({ id: t.backupRuns.id }).from(t.backupRuns)
      .where(and(eq(t.backupRuns.site_id, site.id), eq(t.backupRuns.kind, "scheduled"), eq(t.backupRuns.status, "failed"), gte(t.backupRuns.created_at, lastSlot(now, policy.hour))));
    if(!failed) await enqueue(env, site.id, "scheduled");
  }
}

/** Takes the next run that's due, or whose worker stopped, if no other run on its site is active. */
async function claim(env: Env, now: number, siteId?: string): Promise<RunRow | null> {
  const r = t.backupRuns;
  // One statement, so two workers can't claim the same run. The pick is a subquery, which Drizzle has
  // no builder for; the table and columns it touches still come from the schema.
  const [run] = await db(env).update(r).set({
    status: "running",
    lease_until: now + LEASE,
    attempts: sql`${r.attempts} + 1`,
    started_at: sql`COALESCE(${r.started_at}, ${now})`
  }).where(sql`${r.id} = (
    SELECT p.id FROM ${r} p
    WHERE ((p.status = 'queued' AND p.next_at <= ${now}) OR (p.status = 'running' AND p.lease_until < ${now}))
      ${siteId ? sql`AND p.site_id = ${siteId}` : sql``}
      AND NOT EXISTS (SELECT 1 FROM ${r} o WHERE o.site_id = p.site_id AND o.id != p.id AND o.status = 'running' AND o.lease_until >= ${now})
    ORDER BY CASE p.kind WHEN 'restore' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, p.next_at
    LIMIT 1
  )`).returning();
  return run ?? null;
}

/** Errors no retry will fix: the site refusing the panel, a snapshot that doesn't fit. */
function permanent(error: unknown): boolean {
  if(error instanceof PanelError) return error.status < 500;
  if(!(error instanceof BackupError)) return false;
  const tag = (error.details as { tag?: string } | undefined)?.tag;
  return tag === "Unauthorized" || tag === "Forbidden" || tag === "Rejected" || tag === "NotFound" || tag === "InvalidInput";
}

function explain(error: unknown, origin: string | null): string {
  const message = (error as Error).message;
  const tag = (error as BackupError).details && ((error as BackupError).details as { tag?: string }).tag;
  if(tag === "Unauthorized" || tag === "Forbidden") {
    return `${message}. The site has to let this panel back it up: it needs VIBE_ORG=${origin} and \`backups: true\` in its config.`;
  }
  return message;
}

async function recordSnapshot(env: Env, siteId: string, kind: SnapshotRow["kind"], taken: Awaited<ReturnType<typeof takeSnapshot>>) {
  await db(env).insert(t.backupSnapshots).values({
    id: taken.path,
    site_id: siteId,
    taken_at: taken.manifest.takenAt,
    kind,
    documents: taken.manifest.tables.documents,
    files: taken.manifest.files.count,
    bytes: taken.manifest.files.bytes,
    warnings: JSON.stringify(taken.warnings)
  }).onConflictDoUpdate({ target: t.backupSnapshots.id, set: {
    site_id: siteId,
    taken_at: taken.manifest.takenAt,
    kind,
    documents: taken.manifest.tables.documents,
    files: taken.manifest.files.count,
    bytes: taken.manifest.files.bytes,
    warnings: JSON.stringify(taken.warnings)
  } });
}

async function execute(env: Env, run: RunRow) {
  const site = await siteById(env, run.site_id);
  if(!site) throw new PanelError(404, "The site was removed from the panel");
  const store = bucketStore(env.BACKUPS!);
  const call = panelCaller(env, site);
  let beat = 0;
  function onProgress(progress: Progress) {
    if(Date.now() - beat < 10_000) return;
    beat = Date.now();
    void db(env).update(t.backupRuns).set({ lease_until: Date.now() + LEASE, progress: JSON.stringify(progress) }).where(eq(t.backupRuns.id, run.id));
  }
  const state = JSON.parse(run.state ?? "{}") as { safety?: string };
  function save() {
    return db(env).update(t.backupRuns).set({ state: JSON.stringify(state) }).where(eq(t.backupRuns.id, run.id));
  }

  if(run.kind !== "restore") {
    const taken = await takeSnapshot({ call, store, onProgress });
    await recordSnapshot(env, site.id, run.kind, taken);
    await db(env).update(t.backupRuns).set({ snapshot: taken.path }).where(eq(t.backupRuns.id, run.id));
    await prune(env, site.id);
    return;
  }
  const source = run.snapshot!;
  await readSnapshot(store, source);
  // The site as it was, first, once: a resumed run doesn't take another.
  if(!state.safety) {
    const safety = await takeSnapshot({ call, store, onProgress });
    await recordSnapshot(env, site.id, "safety", safety);
    state.safety = safety.path;
    await save();
  }
  await restoreSnapshot({ call, store, path: source, onProgress });
  const verified = await verifyRestore({ call, store, path: source });
  if(!verified.ok) {
    await db(env).update(t.backupRuns).set({ progress: JSON.stringify({ step: "verified", differences: verified.differences }) }).where(eq(t.backupRuns.id, run.id));
  }
}

/**
 * Runs due work until `budget` runs out: scheduled snapshots, retries, and runs whose Worker
 * stopped mid-way. Called by the cron trigger, and right after someone asks for a run.
 */
export async function processBackups(env: Env, options: { budget?: number, siteId?: string, schedule?: boolean } = {}) {
  if(!env.BACKUPS) return;
  const started = Date.now();
  const budget = options.budget ?? 10 * 60 * 1000;
  if(options.schedule !== false) await enqueueDue(env, started);
  const origin = env.VIBE_ORG ?? null;
  while(Date.now() - started < budget) {
    const run = await claim(env, Date.now(), options.siteId);
    if(!run) return;
    try {
      await execute(env, run);
      await db(env).update(t.backupRuns).set({ status: "done", finished_at: Date.now(), lease_until: null, error: null }).where(eq(t.backupRuns.id, run.id));
    } catch (error) {
      console.error("vibe-panel: backup run failed", run.id, error);
      const final = permanent(error) || run.attempts >= MAX_ATTEMPTS;
      const retryIn = Math.min(60, 2 ** run.attempts) * 60_000;
      await db(env).update(t.backupRuns).set({
        status: final ? "failed" : "queued",
        next_at: Date.now() + retryIn,
        lease_until: null,
        error: explain(error, origin),
        finished_at: final ? Date.now() : null
      }).where(eq(t.backupRuns.id, run.id));
    }
  }
}

// --- API -----------------------------------------------------------------------------------

function toRun(row: RunRow) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    snapshot: row.snapshot,
    attempts: row.attempts,
    progress: row.progress ? JSON.parse(row.progress) : null,
    error: row.error,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    retryAt: row.status === "queued" && row.attempts > 0 ? row.next_at : null
  };
}

async function siteBackups(env: Env, site: PanelSite): Promise<SiteBackups> {
  const [own, effective, origin, snapshots, runs, trusted] = await Promise.all([
    storedPolicy(env, site.id),
    effectivePolicy(env, site.id),
    Promise.resolve(hubOrg(env)),
    db(env).select().from(t.backupSnapshots).where(eq(t.backupSnapshots.site_id, site.id)).orderBy(desc(t.backupSnapshots.taken_at)),
    db(env).select().from(t.backupRuns).where(eq(t.backupRuns.site_id, site.id)).orderBy(desc(t.backupRuns.created_at)).limit(20),
    fetchDescriptor(site.url).then(d => ({ org: d.org, backups: d.backups }), () => undefined)
  ]);
  return {
    available: Boolean(env.BACKUPS),
    panel: origin,
    trusted: trusted === undefined ? null : trusted.org === origin && trusted.backups,
    trustedPanel: trusted?.org && trusted.org !== origin ? trusted.org : null,
    policy: own,
    effective,
    nextAt: effective.enabled ? lastSlot(Date.now(), effective.hour) + DAY : null,
    snapshots: snapshots.map(s => ({
      id: s.id,
      takenAt: s.taken_at,
      kind: s.kind,
      documents: s.documents,
      files: s.files,
      bytes: s.bytes,
      warnings: JSON.parse(s.warnings) as string[]
    })),
    runs: runs.map(toRun)
  };
}

/** Checks the user may restore this site: the site itself decides, through the user's own session. */
async function canRestore(env: Env, session: SessionRow, site: PanelSite) {
  const code = await codeFor(env, session, site);
  const { url, prefix } = apiParts(site);
  const exchange = await fetch(`${url}${prefix}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const { token } = await exchange.json().catch(() => ({})) as { token?: string };
  if(!token) throw new PanelError(502, "The site refused the sign-in");
  const result = await httpCaller({ url, prefix, token })("backups.restoreStatus", {});
  if(result.isErr()) {
    throw new PanelError(result.error._tag === "Forbidden" ? 403 : 502, result.error._tag === "Forbidden"
      ? "Your role on this site doesn't allow restoring backups (it needs `backups: true`)"
      : result.error.message);
  }
}

/** `/api/backups…` and `/api/sites/<id>/backups…`. Returns null for other paths. */
export async function backupsApi(request: Request, env: Env, session: SessionRow, path: string, ctx?: ExecutionContext): Promise<Response | null> {
  const method = request.method;
  function kick(siteId: string) {
    // Starts at once; if this Worker stops first, the cron trigger takes the run over.
    if(ctx) ctx.waitUntil(processBackups(env, { siteId, schedule: false, budget: 25_000 }).catch(error => console.error(error)));
  }

  if(path === "/backups" && method === "GET") {
    return json({ available: Boolean(env.BACKUPS), panel: env.VIBE_ORG ? hubOrg(env) : null, defaults: await defaultPolicy(env) });
  }
  if(path === "/backups/download" && method === "GET") {
    const id = new URL(request.url).searchParams.get("snapshot") ?? "";
    const [row] = await db(env).select().from(t.backupSnapshots).where(eq(t.backupSnapshots.id, id));
    if(!row || !env.BACKUPS) return json({ error: "Unknown snapshot" }, { status: 404 });
    const site = await siteById(env, row.site_id);
    const slug = (site?.name ?? row.site_id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
    const stamp = new Date(row.taken_at).toISOString().slice(0, 16).replace(/[T:]/g, "-");
    // Streams from the archive as it's packed; nothing is built up in memory.
    return new Response(await packSnapshot(bucketStore(env.BACKUPS), row.id), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${slug}-${stamp}.vibe"`,
        "cache-control": "no-store"
      }
    });
  }
  if(path === "/backups/defaults" && method === "PUT") {
    const { policy } = await request.json() as { policy?: unknown };
    await savePolicy(env, "*", cleanPolicy(policy), session.sub);
    return json({ defaults: await defaultPolicy(env) });
  }

  const m = /^\/sites\/([^/]+)\/backups(\/policy|\/restore)?$/.exec(path);
  if(!m) return null;
  const site = await siteById(env, decodeURIComponent(m[1]!));
  if(!site) return json({ error: "Unknown site" }, { status: 404 });
  if(!env.BACKUPS && method !== "GET") return json({ error: "This panel has no BACKUPS bucket" }, { status: 501 });

  if(!m[2] && method === "GET") return json(await siteBackups(env, site));
  if(!m[2] && method === "POST") {
    const id = await enqueue(env, site.id, "manual", { user: session.email ?? session.sub });
    kick(site.id);
    return json({ run: id }, { status: 202 });
  }
  if(m[2] === "/policy" && method === "PUT") {
    const { policy } = await request.json() as { policy?: unknown };
    await savePolicy(env, site.id, policy === null ? null : cleanPolicy(policy), session.sub);
    return json(await siteBackups(env, site));
  }
  if(m[2] === "/restore" && method === "POST") {
    const { snapshot } = await request.json() as { snapshot?: string };
    const [row] = snapshot ? await db(env).select().from(t.backupSnapshots).where(eq(t.backupSnapshots.id, snapshot)) : [];
    if(!row) return json({ error: "Unknown snapshot" }, { status: 404 });
    await canRestore(env, session, site);
    const id = await enqueue(env, site.id, "restore", { snapshot: row.id, user: session.email ?? session.sub });
    kick(site.id);
    return json({ run: id }, { status: 202 });
  }
  return json({ error: "Not found" }, { status: 404 });
}
