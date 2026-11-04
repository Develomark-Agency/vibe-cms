import type { AnyConfig, Collection } from "../config.ts";
import type { AnySchema, ArraySchema, ObjectSchema, OptionalSchema, UnionSchema } from "../schema/types.ts";
import type { D1 } from "./platform.ts";
import { jsonPath } from "./sql.ts";
import { titleField } from "../title.ts";

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
  )`,
  // Sign-in for sites without an org (VIBE_ORG): people who may sign in, by email, with roles given in the editor.
  `CREATE TABLE IF NOT EXISTS vibe_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    roles TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT NOT NULL,
    last_sign_in_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS vibe_passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    public_key TEXT NOT NULL,
    counter INTEGER NOT NULL,
    transports TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  // Invite links, stored as hashes: one registers a passkey for that user.
  `CREATE TABLE IF NOT EXISTS vibe_invites (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // Signed-in browsers: an httpOnly cookie names one, and the editor trades it for a session token.
  `CREATE TABLE IF NOT EXISTS vibe_signins (
    hash TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // The site as an OAuth server for agents and the CLI, when it signs people in itself.
  `CREATE TABLE IF NOT EXISTS vibe_oauth_clients (
    id TEXT PRIMARY KEY,
    secret_hash TEXT,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS vibe_oauth_codes (
    hash TEXT PRIMARY KEY,
    grant_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // A connected agent or CLI: who approved it (as at sign-in) and what it may do. Roles are worked out on each use.
  `CREATE TABLE IF NOT EXISTS vibe_oauth_grants (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    sub TEXT NOT NULL,
    identity TEXT NOT NULL,
    scope TEXT NOT NULL,
    access_hash TEXT UNIQUE,
    access_expires_at INTEGER,
    refresh_hash TEXT UNIQUE,
    refresh_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`,
  // Passkey challenges and OIDC logins in progress.
  `CREATE TABLE IF NOT EXISTS vibe_challenges (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  // Full-text search over working copies, one row per document and locale. Triggers keep it current.
  `CREATE VIRTUAL TABLE IF NOT EXISTS vibe_search USING fts5(
    id UNINDEXED, locale UNINDEXED, type UNINDEXED, title, body,
    tokenize = 'unicode61 remove_diacritics 2'
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

/** A document's title, by its type's title field. */
function searchTitle(config: AnyConfig, row: string): string {
  const cases = Object.keys(config.schemas).flatMap(type => {
    const field = titleField(config, type);
    return field ? [`WHEN '${type}' THEN json_extract(${row}.draft, ${jsonPath([field])})`] : [];
  });
  return cases.length ? `CASE ${row}.type ${cases.join(" ")} END` : "NULL";
}

/** `json_tree` key patterns (GLOB) of a schema's hidden fields, which editors never see and search skips. */
function hiddenKeys(schema: AnySchema, prefix = "$"): string[] {
  if((schema as { hidden?: boolean }).hidden) return [prefix];
  switch(schema.type) {
    case "optional": return hiddenKeys((schema as OptionalSchema).inner, prefix);
    case "object": return Object.entries((schema as ObjectSchema).shape).flatMap(([key, field]) => hiddenKeys(field, `${prefix}.${key}`));
    case "array": return hiddenKeys((schema as ArraySchema).item, `${prefix}[[]*]`);
    case "union": return (schema as UnionSchema).options.flatMap(option => hiddenKeys(option, prefix));
    default: return [];
  }
}

/**
 * A document's readable text whatever its schema: every string with a space in it, anywhere in the
 * draft, blocks and rich text included, except in hidden fields. Ids, slugs, paths, URLs and option
 * values have no spaces.
 */
function searchBody(config: AnyConfig, row: string): string {
  const hidden = Object.entries(config.schemas as Record<string, Collection>).flatMap(([type, collection]) => {
    const keys = [...new Set(hiddenKeys(collection["~collection"].schema))];
    return keys.length ? [`(${row}.type = '${type}' AND (${keys.map(key => `fullkey GLOB '${key}' OR fullkey GLOB '${key}[.[]*'`).join(" OR ")}))`] : [];
  });
  return `(SELECT group_concat(value, ' ') FROM json_tree(${row}.draft)
    WHERE type = 'text' AND instr(trim(value), ' ') > 0
      AND value NOT LIKE 'http%' AND value NOT LIKE '/%' AND value NOT LIKE 'data:%'${hidden.length ? `
      AND NOT (${hidden.join(" OR ")})` : ""})`;
}

/** The triggers that keep `vibe_search` in step with `vibe_documents`. They depend on each type's title field. */
export function searchTriggers(config: AnyConfig): string[] {
  const insert = (row: string) => `INSERT INTO vibe_search (id, locale, type, title, body) VALUES (${row}.id, ${row}.locale, ${row}.type, ${searchTitle(config, row)}, ${searchBody(config, row)});`;
  const remove = "DELETE FROM vibe_search WHERE id = OLD.id AND locale = OLD.locale;";
  return [
    "DROP TRIGGER IF EXISTS vibe_search_insert",
    "DROP TRIGGER IF EXISTS vibe_search_update",
    "DROP TRIGGER IF EXISTS vibe_search_delete",
    `CREATE TRIGGER vibe_search_insert AFTER INSERT ON vibe_documents BEGIN ${insert("NEW")} END`,
    `CREATE TRIGGER vibe_search_update AFTER UPDATE OF draft, type ON vibe_documents BEGIN ${remove} ${insert("NEW")} END`,
    `CREATE TRIGGER vibe_search_delete AFTER DELETE ON vibe_documents BEGIN ${remove} END`
  ];
}

/** Refills `vibe_search` from every document, as the current triggers would have. */
export function searchRebuild(config: AnyConfig): string[] {
  return [
    "DELETE FROM vibe_search",
    `INSERT INTO vibe_search (id, locale, type, title, body) SELECT d.id, d.locale, d.type, ${searchTitle(config, "d")}, ${searchBody(config, "d")} FROM vibe_documents d`
  ];
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
  // The search triggers change when a title field does; reinstall them and reindex, once per change.
  const triggers = searchTriggers(config);
  const version = await sha256(triggers.join("\n"));
  if(await getMeta(db, "search_index") === version) return;
  await db.batch([...triggers, ...searchRebuild(config)].map(sql => db.prepare(sql)).concat(
    db.prepare("INSERT OR REPLACE INTO vibe_meta (key, value) VALUES ('search_index', ?)").bind(version)
  ));
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
