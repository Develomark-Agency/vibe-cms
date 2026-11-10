import type { AnyConfig, Collection } from "../config.ts";
import { migrations } from "../db/migrations/index.ts";
import { runMigrations } from "../db/migrate.ts";
import type { AnySchema, ArraySchema, ObjectSchema, OptionalSchema, UnionSchema } from "../schema/types.ts";
import type { D1 } from "./platform.ts";
import { jsonPath } from "./sql.ts";
import { titleField } from "../title.ts";

export type { AssetRow, DocumentRow, ScheduleRow, TrashRow, VersionRow } from "../db/schema.ts";

/** Full-text search over working copies, one row per document and locale. Triggers keep it current. */
const searchTable = `CREATE VIRTUAL TABLE IF NOT EXISTS vibe_search USING fts5(
  id UNINDEXED, locale UNINDEXED, type UNINDEXED, title, body,
  tokenize = 'unicode61 remove_diacritics 2'
)`;

/** Expression indexes for every `indexed: true` field, on the published copy. */
export function indexStatements(config: AnyConfig): string[] {
  const out: string[] = [];
  for(const [type, collection] of Object.entries(config.schemas as Record<string, Collection>)) {
    for(const path of indexedPaths(collection["~collection"].schema)) {
      const name = `vibe_idx_${type}_${path.join("_")}`.replace(/[^\w]/g, "_");
      out.push(`CREATE INDEX IF NOT EXISTS ${name}_p ON vibe_documents (json_extract(published, ${jsonPath(path)})) WHERE type = '${type}'`);
    }
  }
  return out;
}

/** The newest branch's copy of the document row `row`, as JSON text. */
function newestBranch(row: string): string {
  return `(SELECT b.data FROM vibe_branches b WHERE b.id = ${row}.id AND b.locale = ${row}.locale ORDER BY b.updated_at DESC LIMIT 1)`;
}

/** A document's title, by its type's title field: as it's being edited, else as published. */
function searchTitle(config: AnyConfig, row: string): string {
  const cases = Object.keys(config.schemas).flatMap(type => {
    const field = titleField(config, type);
    return field ? [`WHEN '${type}' THEN COALESCE(json_extract(${newestBranch(row)}, ${jsonPath([field])}), json_extract(${row}.published, ${jsonPath([field])}))`] : [];
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
 * live copy or anyone's branch, blocks and rich text included, except in hidden fields. Ids, slugs,
 * paths, URLs and option values have no spaces.
 */
function searchBody(config: AnyConfig, row: string): string {
  const hidden = Object.entries(config.schemas as Record<string, Collection>).flatMap(([type, collection]) => {
    const keys = [...new Set(hiddenKeys(collection["~collection"].schema))];
    return keys.length ? [`(${row}.type = '${type}' AND (${keys.map(key => `fullkey GLOB '${key}' OR fullkey GLOB '${key}[.[]*'`).join(" OR ")}))`] : [];
  });
  const copies = `(SELECT ${row}.published AS copy WHERE ${row}.published IS NOT NULL
    UNION ALL SELECT b.data FROM vibe_branches b WHERE b.id = ${row}.id AND b.locale = ${row}.locale)`;
  return `(SELECT group_concat(value, ' ') FROM ${copies} AS copies, json_tree(copies.copy)
    WHERE type = 'text' AND instr(trim(value), ' ') > 0
      AND value NOT LIKE 'http%' AND value NOT LIKE '/%' AND value NOT LIKE 'data:%'${hidden.length ? `
      AND NOT (${hidden.join(" OR ")})` : ""})`;
}

/**
 * The triggers that keep `vibe_search` in step with documents and their branches: one row per document
 * and locale. They depend on each type's title field.
 */
export function searchTriggers(config: AnyConfig): string[] {
  function refresh(id: string, locale: string) {
    return `DELETE FROM vibe_search WHERE id = ${id} AND locale = ${locale};
      INSERT INTO vibe_search (id, locale, type, title, body)
        SELECT d.id, d.locale, d.type, ${searchTitle(config, "d")}, ${searchBody(config, "d")} FROM vibe_documents d WHERE d.id = ${id} AND d.locale = ${locale};`;
  }
  const names = ["insert", "update", "delete", "branch_insert", "branch_update", "branch_delete"];
  return [
    ...names.map(name => `DROP TRIGGER IF EXISTS vibe_search_${name}`),
    `CREATE TRIGGER vibe_search_insert AFTER INSERT ON vibe_documents BEGIN ${refresh("NEW.id", "NEW.locale")} END`,
    `CREATE TRIGGER vibe_search_update AFTER UPDATE OF published, type ON vibe_documents BEGIN ${refresh("NEW.id", "NEW.locale")} END`,
    "CREATE TRIGGER vibe_search_delete AFTER DELETE ON vibe_documents BEGIN DELETE FROM vibe_search WHERE id = OLD.id AND locale = OLD.locale; END",
    `CREATE TRIGGER vibe_search_branch_insert AFTER INSERT ON vibe_branches BEGIN ${refresh("NEW.id", "NEW.locale")} END`,
    `CREATE TRIGGER vibe_search_branch_update AFTER UPDATE OF data ON vibe_branches BEGIN ${refresh("NEW.id", "NEW.locale")} END`,
    `CREATE TRIGGER vibe_search_branch_delete AFTER DELETE ON vibe_branches BEGIN ${refresh("OLD.id", "OLD.locale")} END`
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
  // Indexes on the old shared draft column (`…_d`), which a migration drops: they'd block it.
  const stale = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'vibe_idx_%' AND sql LIKE '%json_extract(draft,%'");
  if(stale.length) await db.batch(stale.map(row => db.prepare(`DROP INDEX IF EXISTS "${row.name}"`)));
  await runMigrations(db, migrations, "vibe_migrations");
  await db.batch([searchTable, ...indexStatements(config)].map(sql => db.prepare(sql)));
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
