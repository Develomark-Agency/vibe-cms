import type { ActionCaller } from "../actions/client.ts";
import { ORPCError } from "@orpc/client";
import { isRetryable } from "../actions/errors.ts";
import { pool } from "./pool.ts";
import { BACKUP_TABLE_NAMES, type BackupFile, type BackupManifest, type BackupTable, type RestoreCheck } from "../handler/backups.ts";

/**
 * Taking and restoring snapshots through the `backups.*` actions: the one client the
 * CLI and the panel share. Every step is small and retried, so a slow site, a dropped
 * connection or a restarted run only repeats the step it was on. See `vibe-cms docs backups`.
 */

export type { BackupFile, BackupManifest, BackupTable, RestoreCheck } from "../handler/backups.ts";
export { BACKUP_TABLE_NAMES } from "../handler/backups.ts";

/**
 * Where snapshots live: a folder, a bucket. Paths use `/`. A snapshot is
 * `snapshots/<siteId>/<id>/` (manifest, tables, file list, and `complete.json`
 * last); file bytes are `files/<siteId>/<key>/<version>`, shared by every snapshot
 * that has them unchanged.
 */
export interface BackupStore {
  readText(path: string): Promise<string | null>,
  writeText(path: string, text: string): Promise<void>,
  has(path: string): Promise<boolean>,
  readFile(path: string): Promise<{ body: ReadableStream<Uint8Array>, size: number } | null>,
  /** Must not leave a partial file at `path` if the stream fails. */
  writeFile(path: string, body: ReadableStream<Uint8Array>, size: number): Promise<void>,
  /** Names directly under `path`. */
  list(path: string): Promise<string[]>
}

export interface SnapshotFile {
  key: string,
  mime: string,
  size: number,
  etag: string | null,
  /** Where the bytes are in the store. */
  object: string
}

export interface SnapshotInfo {
  id: string,
  path: string,
  manifest: BackupManifest,
  /** Things that happened while it was taken, e.g. files the site's bucket had lost. */
  warnings: string[]
}

export type Progress =
  | { step: "table", table: BackupTable, rows: number, total: number }
  | { step: "file", key: string, done: number, total: number, transferred: boolean }
  | { step: "retry", what: string, attempt: number, error: string }
  | { step: "commit" };

export interface RunOptions {
  /** Calls the site's actions, e.g. `httpCaller({ url, token })`. */
  call: ActionCaller,
  store: BackupStore,
  /** For file transfers; defaults to the global fetch. */
  fetch?: typeof fetch,
  onProgress?: (progress: Progress) => void,
  /** Attempts per step before giving up. Defaults to 5. */
  attempts?: number,
  /** Files transferred at once. Defaults to 6. */
  concurrency?: number,
  /** Memory the transfers in flight may hold together, in bytes. Defaults to 64 MB (see `transferWeight`). */
  memoryBudget?: number
}

export class BackupError extends Error {
  constructor(message: string, readonly details?: unknown) {
    super(message);
    this.name = "BackupError";
  }
}

const PAGE = 200;

/** Files in flight at once, and what they may hold between them; a Worker has about 128 MB in all. */
const FILE_CONCURRENCY = 6;
const MEMORY_BUDGET = 64 * 1024 * 1024;
/** The most one transfer holds in memory: a part of a large file (smaller files stream and hold far less). */
const PART_WEIGHT = 50 * 1024 * 1024;

/** How much of the budget a file's transfer takes: its size, up to one part. */
function transferWeight(size: number): number {
  return Math.min(size, PART_WEIGHT);
}

function limits(options: RunOptions) {
  return { limit: options.concurrency ?? FILE_CONCURRENCY, budget: options.memoryBudget ?? MEMORY_BUDGET };
}

async function backoff(attempt: number) {
  await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2)));
}

/** Retries network failures and platform errors; the CMS's own refusals fail at once. */
function steady(options: RunOptions) {
  const attempts = options.attempts ?? 5;
  return async function <T>(name: string, input: unknown): Promise<T> {
    for(let attempt = 1; ; attempt++) {
      let failure: string;
      try {
        return await options.call(name, input) as T;
      } catch (error) {
        if(error instanceof ORPCError && (!isRetryable(error) || attempt >= attempts)) throw new BackupError(`${name}: ${error.message}`, { code: error.code, data: error.data });
        if(error instanceof BackupError || attempt >= attempts) throw error;
        failure = (error as Error).message;
      }
      options.onProgress?.({ step: "retry", what: name, attempt, error: failure });
      await backoff(attempt);
    }
  };
}

async function transfer(options: RunOptions, what: string, run: () => Promise<Response>): Promise<Response> {
  const attempts = options.attempts ?? 5;
  for(let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await run();
      if(response.ok) return response;
      const text = await response.text().catch(() => "");
      const message = (() => {
        try {
          return (JSON.parse(text) as { error?: string }).error ?? text;
        } catch {
          return text;
        }
      })() || `HTTP ${response.status}`;
      if(response.status < 500 && response.status !== 429 && response.status !== 422) throw new BackupError(`${what}: ${message}`);
      failure = message;
    } catch (error) {
      if(error instanceof BackupError || attempt >= attempts) throw error;
      failure = (error as Error).message;
    }
    if(attempt >= attempts) throw new BackupError(`${what}: ${failure}`);
    options.onProgress?.({ step: "retry", what, attempt, error: failure });
    await backoff(attempt);
  }
}

function snapshotId(takenAt: number): string {
  return new Date(takenAt).toISOString().replace(/[:.]/g, "-");
}

function fileObject(siteId: string, file: { key: string, etag: string | null, size: number }): string {
  const version = (file.etag ?? `size-${file.size}`).replace(/[^\w-]/g, "");
  return `files/${siteId}/${file.key}/${version || "unknown"}`;
}

/**
 * Takes a snapshot: every table page by page, then each file the store doesn't already
 * have. `complete.json` is written last, so an interrupted snapshot never looks finished.
 */
export async function takeSnapshot(options: RunOptions): Promise<SnapshotInfo> {
  const call = steady(options);
  const doFetch = options.fetch ?? fetch;
  const manifest = await call<BackupManifest>("backups.manifest", {});
  const id = snapshotId(manifest.takenAt);
  const root = `snapshots/${manifest.siteId}/${id}`;
  const warnings: string[] = [];

  for(const table of BACKUP_TABLE_NAMES) {
    const lines: string[] = [];
    let after: string | undefined;
    do {
      const page = await call<{ rows: unknown[], next: string | null }>("backups.export", { table, after, limit: PAGE });
      for(const row of page.rows) lines.push(JSON.stringify(row));
      after = page.next ?? undefined;
      options.onProgress?.({ step: "table", table, rows: lines.length, total: manifest.tables[table] });
    } while(after);
    // Edits during the snapshot can change the count; the manifest records what was saved.
    if(lines.length !== manifest.tables[table]) {
      warnings.push(`${table} changed while the snapshot was taken (${manifest.tables[table]} rows at the start, ${lines.length} saved).`);
      manifest.tables[table] = lines.length;
    }
    await options.store.writeText(`${root}/tables/${table}.jsonl`, lines.join("\n"));
  }

  const files: SnapshotFile[] = [];
  let after: string | undefined;
  do {
    const page = await call<{ files: BackupFile[], next: string | null }>("backups.files", { after, limit: 50 });
    // A page's files download a few at a time, and are recorded in the order the site listed them.
    const saved: Array<SnapshotFile | undefined> = Array.from({ length: page.files.length });
    let finished = files.length;
    await pool(page.files, { ...limits(options), weight: file => (file.exists && file.url ? transferWeight(file.size) : 0) }, async (file, index) => {
      if(!file.exists || !file.url) return;
      const object = fileObject(manifest.siteId, file);
      const have = await options.store.has(object);
      if(!have) {
        const response = await transfer(options, `Downloading ${file.key}`, () => doFetch(file.url!));
        await options.store.writeFile(object, response.body!, file.size);
      }
      saved[index] = { key: file.key, mime: file.mime, size: file.size, etag: file.etag, object };
      options.onProgress?.({ step: "file", key: file.key, done: ++finished, total: manifest.files.count, transferred: !have });
    });
    for(const [index, file] of page.files.entries()) {
      if(saved[index]) files.push(saved[index]!);
      else warnings.push(`${file.key} is in the media library but missing from the site's bucket; it isn't in the snapshot.`);
    }
    after = page.next ?? undefined;
  } while(after);
  manifest.files = { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };

  await options.store.writeText(`${root}/files.json`, JSON.stringify(files));
  await options.store.writeText(`${root}/manifest.json`, JSON.stringify(manifest, null, 2));
  await options.store.writeText(`${root}/complete.json`, JSON.stringify({ completedAt: Date.now(), warnings }, null, 2));
  return { id, path: root, manifest, warnings };
}

/** Finished snapshots of a site in the store, newest first. */
export async function listSnapshots(store: BackupStore, siteId: string): Promise<SnapshotInfo[]> {
  const ids = (await store.list(`snapshots/${siteId}`)).sort().reverse();
  const out: SnapshotInfo[] = [];
  for(const id of ids) {
    const snapshot = await readSnapshot(store, `snapshots/${siteId}/${id}`).catch(() => null);
    if(snapshot) out.push(snapshot);
  }
  return out;
}

/** A finished snapshot by its path; throws if it's incomplete or missing. */
export async function readSnapshot(store: BackupStore, path: string): Promise<SnapshotInfo> {
  const complete = await store.readText(`${path}/complete.json`);
  if(!complete) throw new BackupError(`${path} isn't a finished snapshot (no complete.json). It was interrupted; take another.`);
  const manifest = await store.readText(`${path}/manifest.json`);
  if(!manifest) throw new BackupError(`${path} has no manifest.json`);
  return { id: path.split("/").pop()!, path, manifest: JSON.parse(manifest) as BackupManifest, warnings: (JSON.parse(complete) as { warnings?: string[] }).warnings ?? [] };
}

export interface RestorePlan {
  check: RestoreCheck,
  snapshot: BackupManifest,
  /** Rows per table: what the site has now, and what it will have. */
  tables: Record<BackupTable, { now: number, after: number }>,
  files: { now: { count: number, bytes: number }, after: { count: number, bytes: number } }
}

/** What restoring a snapshot would do, without changing anything. */
export async function planRestore(options: RunOptions & { path: string }): Promise<RestorePlan> {
  const call = steady(options);
  const { manifest } = await readSnapshot(options.store, options.path);
  const check = await call<RestoreCheck>("backups.check", { manifest });
  const tables = Object.fromEntries(BACKUP_TABLE_NAMES.map(name => [name, { now: check.current.tables[name], after: manifest.tables[name] }])) as RestorePlan["tables"];
  return { check, snapshot: manifest, tables, files: { now: check.current.files, after: manifest.files } };
}

export interface RestoreResult {
  restoreId: string,
  resumed: boolean,
  warnings: string[],
  files: { uploaded: number, present: number }
}

/**
 * Restores a snapshot: rows into staging, then files, then one commit. Running it again
 * after a failure resumes the same restore; the site only changes at the commit, and
 * only if every row and file arrived.
 */
export async function restoreSnapshot(options: RunOptions & { path: string, force?: boolean }): Promise<RestoreResult> {
  const call = steady(options);
  const doFetch = options.fetch ?? fetch;
  const { manifest } = await readSnapshot(options.store, options.path);

  const status = await call<{ restore: { id: string, stale: boolean, from: { siteId: string, takenAt: number } } | null }>("backups.restoreStatus", {});
  const same = status.restore && !status.restore.stale && status.restore.from.siteId === manifest.siteId && status.restore.from.takenAt === manifest.takenAt;
  const begun = await call<{ restoreId: string, resumed: boolean, warnings: string[] }>("backups.restoreBegin", {
    manifest,
    resume: same ? status.restore!.id : undefined,
    force: options.force
  });
  const restoreId = begun.restoreId;

  // Assets and trash first: files can only be sent for assets the restore has.
  const order: BackupTable[] = ["assets", "trash", ...BACKUP_TABLE_NAMES.filter(name => name !== "assets" && name !== "trash")];
  for(const table of order) {
    const text = await options.store.readText(`${options.path}/tables/${table}.jsonl`);
    // Format 1 snapshots had no branches: their documents carry drafts, which the site turns into branches.
    if(text === null && table === "branches" && manifest.format === 1) continue;
    if(text === null) throw new BackupError(`The snapshot has no ${table} table`);
    const rows = text ? text.split("\n").map(line => JSON.parse(line) as Record<string, unknown>) : [];
    for(let i = 0; i < rows.length || i === 0; i += PAGE) {
      const batch = rows.slice(i, i + PAGE);
      if(batch.length) await call("backups.restoreRows", { restoreId, table, rows: batch });
      options.onProgress?.({ step: "table", table, rows: Math.min(i + PAGE, rows.length), total: rows.length });
      if(!rows.length) break;
    }
  }

  const files = JSON.parse(await options.store.readText(`${options.path}/files.json`) ?? "[]") as SnapshotFile[];
  let uploaded = 0;
  let present = 0;
  const warnings = [...begun.warnings];
  // Files the site had already lost when the snapshot was taken: their assets come back without bytes.
  const saved = new Set(files.map(file => file.key));
  for(const key of await assetKeys(options.store, options.path)) {
    if(saved.has(key)) continue;
    await call("backups.restoreFile", { restoreId, key, size: 0, mime: "application/octet-stream", lost: true });
    warnings.push(`${key} wasn't in the snapshot; its asset is restored without the file.`);
  }
  let finished = 0;
  await pool(files, { ...limits(options), weight: file => transferWeight(file.size) }, async file => {
    const answer = await call<{ status: "present" | "upload", upload?: { url: string }, multipart?: { url: string, partSize: number } }>("backups.restoreFile", {
      restoreId, key: file.key, size: file.size, mime: file.mime, etag: file.etag ?? undefined
    });
    if(answer.status === "present") {
      present++;
    } else {
      async function source() {
        const stored = await options.store.readFile(file.object);
        if(!stored) throw new BackupError(`The snapshot's copy of ${file.key} is missing from the store (${file.object})`);
        return stored;
      }
      if(answer.upload) {
        await transfer(options, `Uploading ${file.key}`, async () => {
          const { body } = await source();
          return doFetch(answer.upload!.url, { method: "PUT", body, headers: { "content-length": String(file.size) }, duplex: "half" } as RequestInit);
        });
      } else if(answer.multipart) {
        await uploadInParts(options, doFetch, file, answer.multipart, source);
      }
      uploaded++;
    }
    options.onProgress?.({ step: "file", key: file.key, done: ++finished, total: files.length, transferred: answer.status !== "present" });
  });

  options.onProgress?.({ step: "commit" });
  await call("backups.restoreCommit", { restoreId, expected: manifest.tables });
  return { restoreId, resumed: begun.resumed, warnings, files: { uploaded, present } };
}

/** Media keys of the snapshot's assets, trashed ones included. */
async function assetKeys(store: BackupStore, path: string): Promise<string[]> {
  const keys: string[] = [];
  for(const line of (await store.readText(`${path}/tables/assets.jsonl`) ?? "").split("\n")) {
    if(line) keys.push((JSON.parse(line) as { key: string }).key);
  }
  for(const line of (await store.readText(`${path}/tables/trash.jsonl`) ?? "").split("\n")) {
    if(!line) continue;
    const row = JSON.parse(line) as { kind: string, payload: string };
    if(row.kind === "asset") keys.push((JSON.parse(row.payload) as { key: string }).key);
  }
  return keys;
}

async function uploadInParts(
  options: RunOptions,
  doFetch: typeof fetch,
  file: SnapshotFile,
  target: { url: string, partSize: number },
  source: () => Promise<{ body: ReadableStream<Uint8Array> }>
) {
  const created = await transfer(options, `Uploading ${file.key}`, () => doFetch(`${target.url}&uploads=1`, { method: "POST" }));
  const { uploadId } = await created.json() as { uploadId: string };
  const parts: Array<{ partNumber: number, etag: string }> = [];
  const reader = (await source()).body.getReader();
  let buffer: Uint8Array = new Uint8Array(0);
  let done = false;
  while(!done || buffer.length) {
    while(!done && buffer.length < target.partSize) {
      const next = await reader.read();
      if(next.done) done = true;
      else buffer = concat(buffer, next.value);
    }
    const chunk = buffer.slice(0, target.partSize);
    buffer = buffer.slice(target.partSize);
    if(!chunk.length) break;
    const partNumber = parts.length + 1;
    const response = await transfer(options, `Uploading ${file.key} (part ${partNumber})`, () => doFetch(`${target.url}&uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`, { method: "PUT", body: chunk }));
    parts.push(await response.json() as { partNumber: number, etag: string });
  }
  await transfer(options, `Uploading ${file.key}`, () => doFetch(`${target.url}&uploadId=${encodeURIComponent(uploadId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parts })
  }));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Checks a restored site against the snapshot: every table's rows and the file count. */
export async function verifyRestore(options: RunOptions & { path: string }): Promise<{ ok: boolean, differences: string[] }> {
  const call = steady(options);
  const { manifest } = await readSnapshot(options.store, options.path);
  const now = await call<BackupManifest>("backups.manifest", {});
  const differences = BACKUP_TABLE_NAMES.filter(name => now.tables[name] !== manifest.tables[name])
    .map(name => `${name}: ${now.tables[name]} rows, the snapshot has ${manifest.tables[name]}`);
  if(now.files.count !== manifest.files.count) differences.push(`files: ${now.files.count}, the snapshot has ${manifest.files.count}`);
  return { ok: differences.length === 0, differences };
}
export { packSnapshot, unpackSnapshot } from "./vibe.ts";
