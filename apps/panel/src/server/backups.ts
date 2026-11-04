import { httpCaller, type ActionCaller } from "vibe-cms/actions";
import { BackupError, packSnapshot, readSnapshot, restoreSnapshot, takeSnapshot, verifyRestore, type BackupStore, type Progress, type SnapshotFile } from "vibe-cms/backups";
import { fetchDescriptor, PanelError, type BackupPolicy, type PanelSite, type SiteBackups } from "vibe-cms/panel";
import { randomString } from "./oidc.ts";
import { backupToken, codeFor, hubOrg } from "./hub.ts";
import { json, siteById, type Env, type SessionRow } from "./shared.ts";

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

export const backupSchema = [
  `CREATE TABLE IF NOT EXISTS panel_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  // site_id '*' is the default for every site; a site's own row overrides it.
  `CREATE TABLE IF NOT EXISTS backup_policies (
    site_id TEXT PRIMARY KEY,
    policy TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    snapshot TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at INTEGER NOT NULL,
    lease_until INTEGER,
    progress TEXT,
    state TEXT,
    error TEXT,
    requested_by TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  )`,
  "CREATE INDEX IF NOT EXISTS backup_runs_site ON backup_runs (site_id, created_at)",
  "CREATE INDEX IF NOT EXISTS backup_runs_due ON backup_runs (status, next_at)",
  `CREATE TABLE IF NOT EXISTS backup_snapshots (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    taken_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    documents INTEGER NOT NULL,
    files INTEGER NOT NULL,
    bytes INTEGER NOT NULL,
    warnings TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS backup_snapshots_site ON backup_snapshots (site_id, taken_at)"
];

export const DEFAULT_POLICY: BackupPolicy = { enabled: true, hour: 3, keepDaily: 14, keepWeekly: 8, keepMonthly: 12 };

const LEASE = 2 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Safety snapshots (taken before a restore) are kept this long whatever the policy says. */
const SAFETY_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

interface RunRow {
  id: string,
  site_id: string,
  kind: "scheduled" | "manual" | "restore",
  snapshot: string | null,
  status: "queued" | "running" | "done" | "failed",
  attempts: number,
  next_at: number,
  lease_until: number | null,
  progress: string | null,
  state: string | null,
  error: string | null,
  requested_by: string | null,
  created_at: number,
  started_at: number | null,
  finished_at: number | null
}

interface SnapshotRow {
  id: string,
  site_id: string,
  taken_at: number,
  kind: "scheduled" | "manual" | "safety",
  documents: number,
  files: number,
  bytes: number,
  warnings: string
}

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
  const count = (n: unknown, fallback: number) => (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1000 ? n as number : fallback);
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_POLICY.enabled,
    hour: Number.isInteger(value.hour) && (value.hour as number) >= 0 && (value.hour as number) <= 23 ? value.hour as number : DEFAULT_POLICY.hour,
    keepDaily: count(value.keepDaily, DEFAULT_POLICY.keepDaily),
    keepWeekly: count(value.keepWeekly, DEFAULT_POLICY.keepWeekly),
    keepMonthly: count(value.keepMonthly, DEFAULT_POLICY.keepMonthly)
  };
}

async function storedPolicy(env: Env, siteId: string): Promise<BackupPolicy | null> {
  const row = await env.DB.prepare("SELECT policy FROM backup_policies WHERE site_id = ?").bind(siteId).first<{ policy: string }>();
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
    await env.DB.prepare("DELETE FROM backup_policies WHERE site_id = ?").bind(siteId).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO backup_policies (site_id, policy, updated_by, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (site_id) DO UPDATE SET policy = excluded.policy, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(siteId, JSON.stringify(cleanPolicy(policy)), user, Date.now()).run();
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
  const { results } = await env.DB.prepare("SELECT id, taken_at, kind FROM backup_snapshots WHERE site_id = ?").bind(siteId).all<SnapshotRow>();
  const keep = retained(results, policy, Date.now());
  const doomed = results.filter(s => !keep.has(s.id));
  for(const s of doomed) {
    await deletePrefix(bucket, `${s.id}/`);
    await env.DB.prepare("DELETE FROM backup_snapshots WHERE id = ?").bind(s.id).run();
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
    const active = await env.DB.prepare("SELECT id FROM backup_runs WHERE site_id = ? AND kind != 'restore' AND status IN ('queued', 'running')").bind(siteId).first<{ id: string }>();
    if(active) return active.id;
  } else {
    const restoring = await env.DB.prepare("SELECT 1 FROM backup_runs WHERE site_id = ? AND kind = 'restore' AND status IN ('queued', 'running')").bind(siteId).first();
    if(restoring) throw new PanelError(409, "A restore of this site is already under way");
  }
  const id = `run_${randomString(12)}`;
  await env.DB.prepare("INSERT INTO backup_runs (id, site_id, kind, snapshot, status, next_at, requested_by, created_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)")
    .bind(id, siteId, kind, options.snapshot ?? null, Date.now(), options.user ?? null, Date.now()).run();
  return id;
}

/** Queues the scheduled snapshot of every site whose time has come and has none since. */
async function enqueueDue(env: Env, now: number) {
  const { results: sites } = await env.DB.prepare(
    `SELECT s.id, max(b.taken_at) AS last FROM sites s
     LEFT JOIN backup_snapshots b ON b.site_id = s.id AND b.kind IN ('scheduled', 'manual')
     GROUP BY s.id`
  ).all<{ id: string, last: number | null }>();
  for(const site of sites) {
    const policy = await effectivePolicy(env, site.id);
    if(!policy.enabled || (site.last ?? 0) >= lastSlot(now, policy.hour)) continue;
    // A run that failed for good waits for the next slot rather than retrying all day.
    const failed = await env.DB.prepare("SELECT 1 FROM backup_runs WHERE site_id = ? AND kind = 'scheduled' AND status = 'failed' AND created_at >= ?")
      .bind(site.id, lastSlot(now, policy.hour)).first();
    if(!failed) await enqueue(env, site.id, "scheduled");
  }
}

/** Takes the next run that's due, or whose worker stopped, if no other run on its site is active. */
async function claim(env: Env, now: number, siteId?: string): Promise<RunRow | null> {
  return env.DB.prepare(
    `UPDATE backup_runs SET status = 'running', lease_until = ?1, attempts = attempts + 1, started_at = COALESCE(started_at, ?2)
     WHERE id = (
       SELECT r.id FROM backup_runs r
       WHERE ((r.status = 'queued' AND r.next_at <= ?2) OR (r.status = 'running' AND r.lease_until < ?2))
         AND (?3 IS NULL OR r.site_id = ?3)
         AND NOT EXISTS (SELECT 1 FROM backup_runs o WHERE o.site_id = r.site_id AND o.id != r.id AND o.status = 'running' AND o.lease_until >= ?2)
       ORDER BY CASE r.kind WHEN 'restore' THEN 0 WHEN 'manual' THEN 1 ELSE 2 END, r.next_at
       LIMIT 1
     )
     RETURNING *`
  ).bind(now + LEASE, now, siteId ?? null).first<RunRow>();
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
  await env.DB.prepare("INSERT OR REPLACE INTO backup_snapshots (id, site_id, taken_at, kind, documents, files, bytes, warnings) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(taken.path, siteId, taken.manifest.takenAt, kind, taken.manifest.tables.documents, taken.manifest.files.count, taken.manifest.files.bytes, JSON.stringify(taken.warnings))
    .run();
}

async function execute(env: Env, run: RunRow) {
  const site = await siteById(env, run.site_id);
  if(!site) throw new PanelError(404, "The site was removed from the panel");
  const store = bucketStore(env.BACKUPS!);
  const call = panelCaller(env, site);
  let beat = 0;
  const onProgress = (progress: Progress) => {
    if(Date.now() - beat < 10_000) return;
    beat = Date.now();
    void env.DB.prepare("UPDATE backup_runs SET lease_until = ?, progress = ? WHERE id = ?").bind(Date.now() + LEASE, JSON.stringify(progress), run.id).run();
  };
  const state = JSON.parse(run.state ?? "{}") as { safety?: string };
  const save = () => env.DB.prepare("UPDATE backup_runs SET state = ? WHERE id = ?").bind(JSON.stringify(state), run.id).run();

  if(run.kind !== "restore") {
    const taken = await takeSnapshot({ call, store, onProgress });
    await recordSnapshot(env, site.id, run.kind, taken);
    await env.DB.prepare("UPDATE backup_runs SET snapshot = ? WHERE id = ?").bind(taken.path, run.id).run();
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
    await env.DB.prepare("UPDATE backup_runs SET progress = ? WHERE id = ?").bind(JSON.stringify({ step: "verified", differences: verified.differences }), run.id).run();
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
      await env.DB.prepare("UPDATE backup_runs SET status = 'done', finished_at = ?, lease_until = NULL, error = NULL WHERE id = ?").bind(Date.now(), run.id).run();
    } catch (error) {
      console.error("vibe-panel: backup run failed", run.id, error);
      const final = permanent(error) || run.attempts >= MAX_ATTEMPTS;
      const retryIn = Math.min(60, 2 ** run.attempts) * 60_000;
      await env.DB.prepare("UPDATE backup_runs SET status = ?, next_at = ?, lease_until = NULL, error = ?, finished_at = ? WHERE id = ?")
        .bind(final ? "failed" : "queued", Date.now() + retryIn, explain(error, origin), final ? Date.now() : null, run.id).run();
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
    env.DB.prepare("SELECT * FROM backup_snapshots WHERE site_id = ? ORDER BY taken_at DESC").bind(site.id).all<SnapshotRow>(),
    env.DB.prepare("SELECT * FROM backup_runs WHERE site_id = ? ORDER BY created_at DESC LIMIT 20").bind(site.id).all<RunRow>(),
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
    snapshots: snapshots.results.map(s => ({
      id: s.id,
      takenAt: s.taken_at,
      kind: s.kind,
      documents: s.documents,
      files: s.files,
      bytes: s.bytes,
      warnings: JSON.parse(s.warnings) as string[]
    })),
    runs: runs.results.map(toRun)
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
  const kick = (siteId: string) => {
    // Starts at once; if this Worker stops first, the cron trigger takes the run over.
    if(ctx) ctx.waitUntil(processBackups(env, { siteId, schedule: false, budget: 25_000 }).catch(error => console.error(error)));
  };

  if(path === "/backups" && method === "GET") {
    return json({ available: Boolean(env.BACKUPS), panel: env.VIBE_ORG ? hubOrg(env) : null, defaults: await defaultPolicy(env) });
  }
  if(path === "/backups/download" && method === "GET") {
    const id = new URL(request.url).searchParams.get("snapshot") ?? "";
    const row = await env.DB.prepare("SELECT * FROM backup_snapshots WHERE id = ?").bind(id).first<SnapshotRow>();
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
    const row = snapshot ? await env.DB.prepare("SELECT * FROM backup_snapshots WHERE id = ?").bind(snapshot).first<SnapshotRow>() : null;
    if(!row) return json({ error: "Unknown snapshot" }, { status: 404 });
    await canRestore(env, session, site);
    const id = await enqueue(env, site.id, "restore", { snapshot: row.id, user: session.email ?? session.sub });
    kick(site.id);
    return json({ run: id }, { status: 202 });
  }
  return json({ error: "Not found" }, { status: 404 });
}
