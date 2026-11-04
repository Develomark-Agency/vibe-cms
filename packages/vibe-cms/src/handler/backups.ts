import { HttpError, serializeConfig } from "../config.ts";
import pkg from "../../package.json" with { type: "json" };
import { require, signValue } from "./auth.ts";
import { count, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { documents as documentsTable, meta } from "../db/schema.ts";
import { all, first, getMeta, newId, run, searchRebuild, sha256 } from "./db.ts";
import type { Engine } from "./engine.ts";
import type { D1, R2 } from "./platform.ts";

/**
 * Backups: a site's content as rows and files, read out and written back in small
 * pieces, so no single request does much work. See `vibe-cms docs backups`.
 *
 * A restore never touches live tables until it commits: rows go into staging tables
 * (`vibe_restore_*`), files into R2 under their own keys, and the commit swaps every
 * table in one D1 batch, which is a transaction. A failed or abandoned restore leaves
 * the site as it was.
 */

export const BACKUP_FORMAT = 1;

interface TableSpec {
  table: string,
  columns: readonly string[],
  key: readonly string[],
  /** Only these rows of the table belong to a backup. */
  where?: string
}

/** What a backup holds. Sessions, codes, the session secret, the site ID and the search index stay with the site. */
export const BACKUP_TABLES = {
  documents: {
    table: "vibe_documents",
    columns: ["id", "type", "locale", "draft", "published", "published_ver", "schema_hash", "created_at", "updated_at", "published_at", "updated_by"],
    key: ["id", "locale"]
  },
  versions: { table: "vibe_versions", columns: ["id", "locale", "ver", "data", "author", "created_at"], key: ["id", "locale", "ver"] },
  schedules: { table: "vibe_schedules", columns: ["id", "locale", "ver", "action", "run_at", "created_by"], key: ["id", "locale", "action"] },
  assets: { table: "vibe_assets", columns: ["id", "key", "folder", "filename", "mime", "size", "meta", "created_at", "created_by"], key: ["id"] },
  folders: { table: "vibe_folders", columns: ["path", "created_at"], key: ["path"] },
  trash: { table: "vibe_trash", columns: ["id", "kind", "type", "item_id", "locale", "label", "payload", "deleted_at", "deleted_by"], key: ["id"] },
  // The site's name, accent and icon. Not its ID: a restored site keeps its own identity.
  settings: { table: "vibe_meta", columns: ["key", "value"], key: ["key"], where: "key = 'site'" }
} as const satisfies Record<string, TableSpec>;

export type BackupTable = keyof typeof BACKUP_TABLES;
export const BACKUP_TABLE_NAMES = Object.keys(BACKUP_TABLES) as BackupTable[];

const RESTORE_KEY = "restore";
/** An unfinished restore older than this no longer blocks a new one. */
const RESTORE_STALE = 24 * 60 * 60 * 1000;
const LINK_TTL = 60 * 60;
/** Larger files are restored in parts: Workers accept request bodies of 100 MB on most plans. Tests lower these. */
export const UPLOAD_LIMITS = { single: 90 * 1024 * 1024, part: 50 * 1024 * 1024 };

export interface BackupManifest {
  format: number,
  siteId: string,
  name: string | null,
  takenAt: number,
  engine: string,
  locales: string[],
  /** Per content type: its schema's hash and how many documents (one per locale) it has. */
  types: Record<string, { hash: string, documents: number }>,
  tables: Record<BackupTable, number>,
  files: { count: number, bytes: number }
}

export interface BackupFile {
  key: string,
  mime: string,
  size: number,
  /** R2's etag, when the binding can read it without the body. Unchanged etag, unchanged bytes. */
  etag: string | null,
  /** False when the database lists the file but the bucket doesn't have it. */
  exists: boolean,
  /** A signed link to the bytes, good for an hour. */
  url: string | null
}

export interface RestoreCheck {
  ok: boolean,
  /** Reasons the snapshot can't be restored here. */
  problems: string[],
  /** Things to know that don't stop a restore. */
  warnings: string[],
  current: { tables: Record<BackupTable, number>, files: { count: number, bytes: number } }
}

interface RestoreLock {
  id: string,
  startedAt: number,
  by: string,
  from: { siteId: string, takenAt: number }
}

function staging(name: BackupTable): string {
  return `vibe_restore_${name}`;
}

function guard(engine: Engine, action: "read" | "write") {
  if(engine.scope.trusted && !engine.scope.session) return;
  require(engine.config, engine.scope.session, { action, scope: "backups" });
}

function typeHashes(engine: Engine): Promise<Record<string, string>> {
  const { schemas } = serializeConfig(engine.config);
  return Promise.all(Object.entries(schemas).map(async ([type, schema]) => [type, (await sha256(JSON.stringify(schema))).slice(0, 16)] as const))
    .then(Object.fromEntries);
}

function encodeCursor(values: unknown[]): string {
  return btoa(JSON.stringify(values)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(cursor: string, length: number): unknown[] {
  try {
    const values = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/"))) as unknown;
    if(Array.isArray(values) && values.length === length) return values;
  } catch {}
  throw new HttpError(400, "Invalid cursor: pass back `next` from the previous page");
}

/** A Drizzle query as a D1 statement, to join a `db.batch` with the raw statements around it. */
function prepared(db: D1, query: { toSQL(): { sql: string, params: unknown[] } }) {
  const { sql, params } = query.toSQL();
  return db.prepare(sql).bind(...params);
}

// Left raw: the restore's staging tables, the file list's UNION over assets and trash, and everything
// generic over BACKUP_TABLES (table and column names are data there, and staging tables aren't in the schema).
async function counts(db: D1, tables: (name: BackupTable) => string): Promise<Record<BackupTable, number>> {
  const rows = await db.batch(BACKUP_TABLE_NAMES.map(name => {
    const spec: TableSpec = BACKUP_TABLES[name];
    return db.prepare(`SELECT count(*) AS n FROM ${tables(name)}${spec.where ? ` WHERE ${spec.where}` : ""}`);
  }));
  return Object.fromEntries(BACKUP_TABLE_NAMES.map((name, i) => [name, Number((rows[i]!.results?.[0] as { n: number } | undefined)?.n ?? 0)])) as Record<BackupTable, number>;
}

/** Every file the backup needs: the library's, and trashed ones, which can still be restored. */
const FILES_SQL = `SELECT key, mime, size FROM (
  SELECT key, mime, size FROM vibe_assets
  UNION SELECT json_extract(payload, '$.key'), json_extract(payload, '$.mime'), json_extract(payload, '$.size') FROM vibe_trash WHERE kind = 'asset'
)`;

async function fileTotals(db: D1): Promise<{ count: number, bytes: number }> {
  const row = await first<{ count: number, bytes: number | null }>(db, `SELECT count(*) AS count, sum(size) AS bytes FROM (${FILES_SQL})`);
  return { count: row?.count ?? 0, bytes: row?.bytes ?? 0 };
}

export async function manifest(engine: Engine): Promise<BackupManifest> {
  guard(engine, "read");
  const { db } = engine;
  const [tables, files, hashes, site, perType] = await Promise.all([
    counts(db, name => BACKUP_TABLES[name].table),
    fileTotals(db),
    typeHashes(engine),
    engine.site(),
    createDb(db).select({ type: documentsTable.type, n: count() }).from(documentsTable).groupBy(documentsTable.type)
  ]);
  const documents = new Map(perType.map(row => [row.type, row.n]));
  const types: BackupManifest["types"] = {};
  for(const [type, hash] of Object.entries(hashes)) types[type] = { hash, documents: documents.get(type) ?? 0 };
  // Documents of types the config no longer has still belong to the backup.
  for(const [type, n] of documents) types[type] ??= { hash: "", documents: n };
  return {
    format: BACKUP_FORMAT,
    siteId: engine.state.siteId,
    // As the editor shows it: the saved name, else the host.
    name: site.name,
    takenAt: Date.now(),
    engine: pkg.version,
    locales: [...(engine.config.locales ?? [engine.config.defaultLocale ?? "en"])],
    types,
    tables,
    files
  };
}

/** One page of a table, in key order. `next` is null on the last page. */
export async function exportRows(engine: Engine, input: { table: BackupTable, after?: string, limit: number }) {
  guard(engine, "read");
  const spec: TableSpec = BACKUP_TABLES[input.table];
  const conditions = spec.where ? [spec.where] : [];
  const params: unknown[] = [];
  if(input.after) {
    conditions.push(`(${spec.key.join(", ")}) > (${spec.key.map(() => "?").join(", ")})`);
    params.push(...decodeCursor(input.after, spec.key.length));
  }
  const rows = await all<Record<string, unknown>>(
    engine.db,
    `SELECT ${spec.columns.join(", ")} FROM ${spec.table}${conditions.length ? ` WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${spec.key.join(", ")} LIMIT ?`,
    [...params, input.limit + 1]
  );
  const more = rows.length > input.limit;
  const page = more ? rows.slice(0, input.limit) : rows;
  const last = page.at(-1);
  return { rows: page, next: more && last ? encodeCursor(spec.key.map(column => last[column])) : null };
}

async function signedLink(engine: Engine, key: string, params: Record<string, string>): Promise<string> {
  const exp = String(Math.floor(Date.now() / 1000) + LINK_TTL);
  const query = new URLSearchParams({ ...params, exp });
  query.sort();
  const sig = await signValue(engine.db, `backup\n${key}\n${query}`);
  query.set("sig", sig);
  return `${engine.scope.origin}${engine.state.prefix}/api/backups/files/${key.split("/").map(encodeURIComponent).join("/")}?${query}`;
}

/** One page of files, in key order, each with a signed download link. */
export async function listFiles(engine: Engine, input: { after?: string, limit: number }) {
  guard(engine, "read");
  const rows = await all<{ key: string, mime: string, size: number }>(
    engine.db,
    `${FILES_SQL} WHERE key > ? ORDER BY key LIMIT ?`,
    [input.after ?? "", input.limit + 1]
  );
  const more = rows.length > input.limit;
  const page = more ? rows.slice(0, input.limit) : rows;
  const storage = engine.state.storage;
  const files: BackupFile[] = await Promise.all(page.map(async row => {
    const head = storage?.head ? await storage.head(row.key) : undefined;
    const exists = head !== null && storage !== undefined;
    return {
      key: row.key,
      mime: row.mime,
      size: head?.size ?? row.size,
      etag: head?.httpEtag ?? null,
      exists,
      url: exists ? await signedLink(engine, row.key, { op: "get" }) : null
    };
  }));
  return { files, next: more ? page.at(-1)!.key : null };
}

// --- Restoring -----------------------------------------------------------------

export async function check(engine: Engine, snapshot: BackupManifest): Promise<RestoreCheck> {
  guard(engine, "read");
  const problems: string[] = [];
  const warnings: string[] = [];
  if(snapshot.format !== BACKUP_FORMAT) problems.push(`This snapshot is format ${snapshot.format}; this site reads format ${BACKUP_FORMAT}. Update vibe-cms on the site.`);
  const hashes = await typeHashes(engine);
  for(const [type, info] of Object.entries(snapshot.types ?? {})) {
    if(!(type in hashes)) {
      if(info.documents > 0) problems.push(`The snapshot has ${info.documents} "${type}" documents, and this site has no "${type}" content type. Deploy the code that defines it first.`);
    } else if(info.hash && info.hash !== hashes[type] && info.documents > 0) {
      warnings.push(`"${type}" changed since the snapshot. Its documents restore as they were saved; any that no longer fit show their issues in the editor (vibe-cms docs schema-changes).`);
    }
  }
  const locales = new Set(engine.config.locales ?? [engine.config.defaultLocale ?? "en"]);
  const missing = (snapshot.locales ?? []).filter(locale => !locales.has(locale));
  if(missing.length) warnings.push(`The snapshot has languages this site doesn't: ${missing.join(", ")}. Those translations restore but stay hidden until the site adds them.`);
  if((snapshot.files?.count ?? 0) > 0 && !engine.state.storage) problems.push("The snapshot has files and this site has no `storage` binding (an R2 bucket).");
  if(snapshot.siteId !== engine.state.siteId) warnings.push(`The snapshot is of another site (${snapshot.name ?? snapshot.siteId}). This site keeps its own ID and sign-in.`);
  const [tables, files] = await Promise.all([counts(engine.db, name => BACKUP_TABLES[name].table), fileTotals(engine.db)]);
  return { ok: problems.length === 0, problems, warnings, current: { tables, files } };
}

async function lock(engine: Engine): Promise<RestoreLock | null> {
  const value = await getMeta(engine.db, RESTORE_KEY);
  return value ? JSON.parse(value) as RestoreLock : null;
}

async function activeRestore(engine: Engine, id: string): Promise<RestoreLock> {
  const current = await lock(engine);
  if(!current || current.id !== id) throw new HttpError(409, "That restore isn't in progress any more. Start again with `backups.restoreBegin`.");
  return current;
}

function stagingStatements(db: D1, drop: boolean) {
  const statements = [];
  for(const name of BACKUP_TABLE_NAMES) {
    const spec: TableSpec = BACKUP_TABLES[name];
    if(drop) statements.push(db.prepare(`DROP TABLE IF EXISTS ${staging(name)}`));
    statements.push(db.prepare(`CREATE TABLE IF NOT EXISTS ${staging(name)} AS SELECT ${spec.columns.join(", ")} FROM ${spec.table} WHERE 0`));
    statements.push(db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS ${staging(name)}_key ON ${staging(name)} (${spec.key.join(", ")})`));
  }
  if(drop) statements.push(db.prepare("DROP TABLE IF EXISTS vibe_restore_files"));
  statements.push(db.prepare("CREATE TABLE IF NOT EXISTS vibe_restore_files (key TEXT PRIMARY KEY)"));
  return statements;
}

function dropStatements(db: D1) {
  return [...BACKUP_TABLE_NAMES.map(name => db.prepare(`DROP TABLE IF EXISTS ${staging(name)}`)), db.prepare("DROP TABLE IF EXISTS vibe_restore_files")];
}

/**
 * Starts a restore, or with `resume` picks one up where it stopped. Nothing live changes
 * until `restoreCommit`.
 */
export async function restoreBegin(engine: Engine, input: { manifest: BackupManifest, resume?: string, force?: boolean }) {
  guard(engine, "write");
  const result = await check(engine, input.manifest);
  if(!result.ok) throw new HttpError(422, `This snapshot can't be restored here: ${result.problems[0]}`, { problems: result.problems, warnings: result.warnings });
  const current = await lock(engine);
  if(input.resume && current?.id === input.resume) {
    await engine.db.batch(stagingStatements(engine.db, false));
    return { restoreId: current.id, resumed: true, warnings: result.warnings };
  }
  if(current && Date.now() - current.startedAt < RESTORE_STALE && !input.force) {
    throw new HttpError(409, `Another restore has been in progress since ${new Date(current.startedAt).toISOString()} (by ${current.by}). Resume it, cancel it, or pass \`force\`.`, { restoreId: current.id });
  }
  const next: RestoreLock = {
    id: newId("restore"),
    startedAt: Date.now(),
    by: engine.scope.session?.email ?? engine.scope.session?.sub ?? "site",
    from: { siteId: input.manifest.siteId, takenAt: input.manifest.takenAt }
  };
  await engine.db.batch([
    ...stagingStatements(engine.db, true),
    prepared(engine.db, createDb(engine.db).insert(meta).values({ key: RESTORE_KEY, value: JSON.stringify(next) })
      .onConflictDoUpdate({ target: meta.key, set: { value: JSON.stringify(next) } }))
  ]);
  return { restoreId: next.id, resumed: false, warnings: result.warnings };
}

function checkRow(spec: TableSpec, row: unknown, index: number): unknown[] {
  if(typeof row !== "object" || row === null || Array.isArray(row)) throw new HttpError(400, `rows[${index}] isn't an object`);
  const record = row as Record<string, unknown>;
  const extra = Object.keys(record).filter(key => !spec.columns.includes(key));
  if(extra.length) throw new HttpError(400, `rows[${index}] has columns ${spec.table} doesn't: ${extra.join(", ")}`);
  return spec.columns.map(column => {
    const value = record[column] ?? null;
    if(value !== null && typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `rows[${index}].${column} must be text, a number or null`);
    if(value === null && spec.key.includes(column)) throw new HttpError(400, `rows[${index}] has no ${column}`);
    return value;
  });
}

/** Writes rows into the restore's staging table. Sending the same rows again changes nothing. */
export async function restoreRows(engine: Engine, input: { restoreId: string, table: BackupTable, rows: unknown[] }) {
  guard(engine, "write");
  await activeRestore(engine, input.restoreId);
  const spec: TableSpec = BACKUP_TABLES[input.table];
  const values = input.rows.map((row, i) => checkRow(spec, row, i));
  if(input.table === "settings" && values.some(row => row[0] !== "site")) throw new HttpError(400, "settings rows can only be the \"site\" key");
  const sql = `INSERT OR REPLACE INTO ${staging(input.table)} (${spec.columns.join(", ")}) VALUES (${spec.columns.map(() => "?").join(", ")})`;
  if(values.length) await engine.db.batch(values.map(row => engine.db.prepare(sql).bind(...row)));
  const staged = await first<{ n: number }>(engine.db, `SELECT count(*) AS n FROM ${staging(input.table)}`);
  return { written: values.length, staged: staged?.n ?? 0 };
}

const ASSET_KEY = /^assets\/[\w-]{1,80}$/;

/**
 * Says whether the site still needs a file's bytes: `present` when the bucket already has
 * them, else where to send them. The file must belong to an asset already sent with `restoreRows`.
 */
export async function restoreFile(engine: Engine, input: { restoreId: string, key: string, size: number, mime: string, etag?: string, lost?: boolean }) {
  guard(engine, "write");
  await activeRestore(engine, input.restoreId);
  if(!ASSET_KEY.test(input.key)) throw new HttpError(400, `"${input.key}" isn't a media key`);
  const storage = engine.state.storage;
  if(!storage) throw new HttpError(501, "No `storage` binding: restoring files needs an R2 bucket");
  const listed = await first(
    engine.db,
    `SELECT 1 FROM ${staging("assets")} WHERE key = ? UNION SELECT 1 FROM ${staging("trash")} WHERE kind = 'asset' AND json_extract(payload, '$.key') = ?`,
    [input.key, input.key]
  );
  if(!listed) throw new HttpError(409, `No asset in this restore uses "${input.key}". Send the assets and trash tables with \`backups.restoreRows\` first.`);
  const head = storage.head ? await storage.head(input.key) : null;
  // The snapshot never had the bytes: the asset comes back and shows as a broken file, rather than blocking the restore.
  if(input.lost) {
    await run(engine.db, "INSERT OR IGNORE INTO vibe_restore_files (key) VALUES (?)", [input.key]);
    return { status: head ? "present" as const : "lost" as const };
  }
  if(head && head.size === input.size && (!input.etag || head.httpEtag === input.etag)) {
    await run(engine.db, "INSERT OR IGNORE INTO vibe_restore_files (key) VALUES (?)", [input.key]);
    return { status: "present" as const };
  }
  const params = { op: "put", restore: input.restoreId, size: String(input.size), type: input.mime };
  if(input.size <= UPLOAD_LIMITS.single) {
    return { status: "upload" as const, upload: { method: "PUT", url: await signedLink(engine, input.key, params) } };
  }
  if(!storage.createMultipartUpload) throw new HttpError(501, `"${input.key}" is ${input.size} bytes, more than one request can carry, and this storage binding can't upload in parts`);
  return { status: "upload" as const, multipart: { url: await signedLink(engine, input.key, params), partSize: UPLOAD_LIMITS.part } };
}

/**
 * Swaps the staged rows in for the live ones, in one transaction, after checking that
 * every table has the rows the caller sent and every file arrived.
 */
export async function restoreCommit(engine: Engine, input: { restoreId: string, expected: Partial<Record<BackupTable, number>> }) {
  guard(engine, "write");
  await activeRestore(engine, input.restoreId);
  const { db } = engine;
  const staged = await counts(db, name => staging(name));
  const mismatched = BACKUP_TABLE_NAMES.filter(name => input.expected[name] !== undefined && input.expected[name] !== staged[name]);
  if(mismatched.length) {
    throw new HttpError(409, `The restore is incomplete: ${mismatched.map(name => `${name} has ${staged[name]} of ${input.expected[name]} rows`).join(", ")}. Send the missing rows again; nothing changed on the site.`, { staged });
  }
  const missing = await all<{ key: string }>(db, `SELECT key FROM (
    SELECT key FROM ${staging("assets")}
    UNION SELECT json_extract(payload, '$.key') FROM ${staging("trash")} WHERE kind = 'asset'
  ) WHERE key NOT IN (SELECT key FROM vibe_restore_files) LIMIT 21`);
  if(missing.length) {
    throw new HttpError(409, `The restore is incomplete: ${missing.length > 20 ? "more than 20" : missing.length} files weren't uploaded (${missing.slice(0, 3).map(m => m.key).join(", ")}${missing.length > 3 ? ", …" : ""}). Upload them again; nothing changed on the site.`, { missing: missing.slice(0, 20).map(m => m.key) });
  }
  const swap = BACKUP_TABLE_NAMES.flatMap(name => {
    const spec: TableSpec = BACKUP_TABLES[name];
    const columns = spec.columns.join(", ");
    return [
      db.prepare(`DELETE FROM ${spec.table}${spec.where ? ` WHERE ${spec.where}` : ""}`),
      db.prepare(`INSERT INTO ${spec.table} (${columns}) SELECT ${columns} FROM ${staging(name)}`)
    ];
  });
  await db.batch([
    ...swap,
    // The favicon is detected again for the restored settings.
    prepared(db, createDb(db).delete(meta).where(inArray(meta.key, ["site_detected", RESTORE_KEY]))),
    ...searchRebuild(engine.config).map(sql => db.prepare(sql)),
    ...dropStatements(db)
  ]);
  return { restored: true as const, tables: staged };
}

/** Drops a restore's staging tables. Files it uploaded stay in the bucket; nothing points at new ones. */
export async function restoreCancel(engine: Engine, input: { restoreId: string }) {
  guard(engine, "write");
  await activeRestore(engine, input.restoreId);
  await engine.db.batch([...dropStatements(engine.db), prepared(engine.db, createDb(engine.db).delete(meta).where(eq(meta.key, RESTORE_KEY)))]);
  return { cancelled: true as const };
}

export async function restoreStatus(engine: Engine) {
  guard(engine, "read");
  const current = await lock(engine);
  if(!current) return { restore: null };
  const staged = await counts(engine.db, name => staging(name)).catch(() => null);
  const files = await first<{ n: number }>(engine.db, "SELECT count(*) AS n FROM vibe_restore_files").catch(() => null);
  return { restore: { ...current, staged, files: files?.n ?? 0, stale: Date.now() - current.startedAt >= RESTORE_STALE } };
}

// --- Transfers -----------------------------------------------------------------

/**
 * `{prefix}/api/backups/files/<key>?…&sig=`: the bytes of backups, streamed between R2 and the
 * caller. The links are signed by the actions that hand them out, so they need no session.
 * GET downloads; PUT uploads in one piece; POST `?uploads` / PUT `?uploadId&part` / POST `?uploadId`
 * uploads in parts.
 */
export async function transferRoute(request: Request, db: D1, storage: R2 | undefined, url: URL, key: string): Promise<Response> {
  if(!storage) throw new HttpError(501, "No `storage` binding");
  const params = new URLSearchParams();
  for(const name of ["op", "restore", "size", "type", "exp"]) {
    const value = url.searchParams.get(name);
    if(value !== null) params.set(name, value);
  }
  params.sort();
  const sig = url.searchParams.get("sig") ?? "";
  const expected = await signValue(db, `backup\n${key}\n${params}`);
  if(sig.length !== expected.length || !timingSafeEqual(sig, expected)) throw new HttpError(403, "Invalid link");
  if(Number(params.get("exp")) * 1000 < Date.now()) throw new HttpError(403, "This link expired. Ask for a new one.");
  const op = params.get("op");

  if(op === "get") {
    if(request.method !== "GET") throw new HttpError(405, "Use GET");
    const object = await storage.get(key);
    if(!object) throw new HttpError(404, "The bucket doesn't have this file");
    return new Response(object.body, {
      headers: {
        "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
        "content-length": String(object.size),
        etag: object.httpEtag,
        "cache-control": "no-store"
      }
    });
  }

  if(op !== "put") throw new HttpError(400, "Unknown transfer");
  const restoreId = params.get("restore")!;
  const current = await getMeta(db, RESTORE_KEY);
  if(!current || (JSON.parse(current) as RestoreLock).id !== restoreId) throw new HttpError(409, "That restore isn't in progress any more");
  const size = Number(params.get("size"));
  const contentType = params.get("type") || "application/octet-stream";

  async function arrived(): Promise<Response> {
    if(storage!.head) {
      const head = await storage!.head(key);
      if(!head || head.size !== size) {
        throw new HttpError(422, `The file arrived with ${head?.size ?? 0} of ${size} bytes. Upload it again.`);
      }
    }
    await run(db, "INSERT OR IGNORE INTO vibe_restore_files (key) VALUES (?)", [key]);
    return Response.json({ key, size });
  }

  const uploadId = url.searchParams.get("uploadId");
  if(request.method === "PUT" && !uploadId) {
    if(!request.body) throw new HttpError(400, "Expected the file as the body");
    const length = Number(request.headers.get("content-length"));
    if(length && length !== size) throw new HttpError(400, `Expected ${size} bytes, got ${length}`);
    await storage.put(key, request.body, { httpMetadata: { contentType } });
    return arrived();
  }
  if(!storage.createMultipartUpload || !storage.resumeMultipartUpload) throw new HttpError(501, "This storage binding can't upload in parts");
  if(request.method === "POST" && url.searchParams.has("uploads")) {
    const upload = await storage.createMultipartUpload(key, { httpMetadata: { contentType } });
    return Response.json({ uploadId: upload.uploadId });
  }
  if(!uploadId) throw new HttpError(400, "Expected uploadId");
  const upload = storage.resumeMultipartUpload(key, uploadId);
  if(request.method === "PUT") {
    const part = Number(url.searchParams.get("part"));
    if(!Number.isInteger(part) || part < 1 || part > 10_000) throw new HttpError(400, "part must be 1-10000");
    if(!request.body) throw new HttpError(400, "Expected the part as the body");
    return Response.json(await upload.uploadPart(part, request.body));
  }
  if(request.method === "POST") {
    const body = await request.json().catch(() => null) as { parts?: Array<{ partNumber: number, etag: string }> } | null;
    if(!Array.isArray(body?.parts) || body.parts.length === 0) throw new HttpError(400, "Expected { parts: [{ partNumber, etag }] }");
    await upload.complete(body.parts);
    return arrived();
  }
  if(request.method === "DELETE") {
    await upload.abort();
    return new Response(null, { status: 204 });
  }
  throw new HttpError(405, "Unsupported method");
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for(let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
