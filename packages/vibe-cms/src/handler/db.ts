import type { AnyConfig, Collection } from "../config.ts";
import type { AnySchema, ObjectSchema, OptionalSchema } from "../schema/types.ts";
import type { D1 } from "./platform.ts";
import { jsonPath } from "./sql.ts";

export interface DocumentRow {
  id: string,
  type: string,
  locale: string,
  draft: string,
  published: string | null,
  published_ver: number | null,
  schema_hash: string,
  created_at: number,
  updated_at: number,
  published_at: number | null,
  updated_by: string | null
}

export interface VersionRow {
  id: string,
  locale: string,
  ver: number,
  data: string,
  author: string,
  created_at: number
}

export interface ScheduleRow {
  id: string,
  locale: string,
  ver: number | null,
  action: "publish" | "unpublish",
  run_at: number,
  created_by: string
}

export interface AssetRow {
  id: string,
  key: string,
  folder: string | null,
  filename: string,
  mime: string,
  size: number,
  meta: string,
  created_at: number,
  created_by: string
}

/** A deleted document (or one translation of it) or media file, kept until it's restored or purged. */
export interface TrashRow {
  id: string,
  kind: "document" | "asset",
  /** Content type for documents; null for assets. */
  type: string | null,
  item_id: string,
  /** The one translation that was deleted; null when the whole document or a file was. */
  locale: string | null,
  label: string,
  /** JSON: the removed `vibe_documents` rows, or the `vibe_assets` row. */
  payload: string,
  deleted_at: number,
  deleted_by: string
}

const tables = [
  `CREATE TABLE IF NOT EXISTS vibe_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vibe_documents (
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    locale TEXT NOT NULL,
    draft TEXT NOT NULL,
    published TEXT,
    published_ver INTEGER,
    schema_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    published_at INTEGER,
    updated_by TEXT,
    PRIMARY KEY (id, locale)
  )`,
  "CREATE INDEX IF NOT EXISTS vibe_documents_type ON vibe_documents (type, locale, updated_at)",
  `CREATE TABLE IF NOT EXISTS vibe_versions (
    id TEXT NOT NULL,
    locale TEXT NOT NULL,
    ver INTEGER NOT NULL,
    data TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (id, locale, ver)
  )`,
  `CREATE TABLE IF NOT EXISTS vibe_schedules (
    id TEXT NOT NULL,
    locale TEXT NOT NULL,
    ver INTEGER,
    action TEXT NOT NULL,
    run_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    PRIMARY KEY (id, locale, action)
  )`,
  "CREATE INDEX IF NOT EXISTS vibe_schedules_run_at ON vibe_schedules (run_at)",
  `CREATE TABLE IF NOT EXISTS vibe_assets (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    folder TEXT,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    meta TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vibe_assets_folder ON vibe_assets (folder, created_at)",
  // Folders that exist on their own, so empty ones survive. Asset folders and their ancestors exist implicitly too.
  `CREATE TABLE IF NOT EXISTS vibe_folders (
    path TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  )`,
  // Deleting moves rows here. Versions and R2 objects stay where they are until the item is purged.
  `CREATE TABLE IF NOT EXISTS vibe_trash (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    type TEXT,
    item_id TEXT NOT NULL,
    locale TEXT,
    label TEXT NOT NULL,
    payload TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    deleted_by TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS vibe_trash_deleted_at ON vibe_trash (deleted_at)",
  "CREATE INDEX IF NOT EXISTS vibe_trash_item ON vibe_trash (item_id)",
  `CREATE TABLE IF NOT EXISTS vibe_codes (
    code TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`
];

/** Expression indexes for every `indexed: true` field, on both the working copy and the published copy. */
export function indexStatements(config: AnyConfig): string[] {
  const out: string[] = [];
  for(const [type, collection] of Object.entries(config.schemas as Record<string, Collection>)) {
    for(const path of indexedPaths(collection["~collection"].schema)) {
      const name = `vibe_idx_${type}_${path.join("_")}`.replace(/[^\w]/g, "_");
      for(const [suffix, column] of [["d", "draft"], ["p", "published"]] as const) {
        out.push(
          `CREATE INDEX IF NOT EXISTS ${name}_${suffix} ON vibe_documents (json_extract(${column}, ${jsonPath(path)})) WHERE type = '${type}'`
        );
      }
    }
  }
  return out;
}

function indexedPaths(schema: ObjectSchema, prefix: string[] = []): string[][] {
  const out: string[][] = [];
  for(const [key, field] of Object.entries(schema.shape)) {
    const inner: AnySchema = field.type === "optional" ? (field as OptionalSchema).inner : field;
    if((inner as { indexed?: boolean }).indexed) out.push([...prefix, key]);
    if(inner.type === "object") out.push(...indexedPaths(inner as ObjectSchema, [...prefix, key]));
  }
  return out;
}

/**
 * Engine migrations run on the first request each isolate handles. Every
 * statement is idempotent, so concurrent isolates are harmless.
 */
export async function migrate(db: D1, config: AnyConfig): Promise<void> {
  await db.batch([...tables, ...indexStatements(config)].map(sql => db.prepare(sql)));
}

export async function all<T>(db: D1, sql: string, params: unknown[] = []): Promise<T[]> {
  const { results } = await db.prepare(sql).bind(...params).all();
  return results as T[];
}

export async function first<T>(db: D1, sql: string, params: unknown[] = []): Promise<T | null> {
  return (await db.prepare(sql).bind(...params).first()) as T | null;
}

export async function run(db: D1, sql: string, params: unknown[] = []): Promise<void> {
  await db.prepare(sql).bind(...params).run();
}

export async function getMeta(db: D1, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(db, "SELECT value FROM vibe_meta WHERE key = ?", [key]);
  return row?.value ?? null;
}

/** Returns the stored value, writing `create()` first if there is none. Race-safe. */
export async function getOrCreateMeta(db: D1, key: string, create: () => string): Promise<string> {
  const existing = await getMeta(db, key);
  if(existing !== null) return existing;
  await run(db, "INSERT OR IGNORE INTO vibe_meta (key, value) VALUES (?, ?)", [key, create()]);
  return (await getMeta(db, key))!;
}

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Short, roughly time-sortable IDs: `doc_lq3x9k2a8f7d`. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const random = crypto.getRandomValues(new Uint8Array(8));
  let tail = "";
  for(const byte of random) tail += alphabet[byte % 36];
  return `${prefix}_${time}${tail}`;
}

export function randomToken(bytes = 32): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
