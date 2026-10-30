import { getSchema, HttpError, type AnyConfig } from "../config.ts";
import type { SerializedQuery, QueryArgs, WithOptions, DocumentMeta, Order, Condition } from "../query/index.ts";
import { parseSize } from "../schema/builders.ts";
import type {
  AnySchema,
  ArraySchema,
  AssetMeta,
  AssetSchema,
  DocumentData,
  ObjectSchema,
  OptionalSchema,
  RefSchema,
  TextSchema,
  UnionSchema
} from "../schema/types.ts";
import { findReferences, isRecord, pickUnionOption, schemaAt, validate, type Issue } from "../schema/validate.ts";
import type { Session, WriteAction } from "../server/index.ts";
import { analyzeImage, extensionFor, mimeFor, mimeMatches } from "./analyze.ts";
import { can, require } from "./auth.ts";
import { all, first, getMeta, newId, run, type AssetRow, type DocumentRow, type ScheduleRow, type TrashRow, type VersionRow } from "./db.ts";
import type { D1, ExecutionContext, R2 } from "./platform.ts";
import type { HookArgs, PluginHost } from "./plugins.ts";
import { jsonPath, SqlBuilder } from "./sql.ts";
import { MAX_TEXT_EDIT_BYTES, textKind } from "../text-files.ts";

export interface EngineState {
  config: AnyConfig,
  db: D1,
  storage: R2 | undefined,
  plugins: PluginHost,
  schemaHash: string,
  prefix: string
}

export interface RequestScope {
  /** Prepended to asset URLs. Empty for in-process queries, which get root-relative URLs. */
  origin: string,
  session: Session | null,
  /** In-process callers (site code, server plugins) may read drafts without a session. */
  trusted: boolean,
  ctx?: ExecutionContext
}

export type Doc = DocumentData & { id: string, $meta: DocumentMeta };

/** How the site presents itself in the editor and the panel. Code sets the defaults; editors can change them. */
export interface SiteSettings {
  name: string,
  /** `#rrggbb`, or null for the neutral default. */
  accent: string | null,
  icon: { id: string, url: string } | null
}

export interface SiteSettingsPatch {
  name?: string,
  accent?: string | null,
  /** Asset ID; null removes the icon. */
  icon?: string | null
}

interface StoredSite {
  name?: string,
  accent?: string,
  icon?: string
}

const SITE_KEY = "site";

/** How long deleted items stay in the trash unless the config says otherwise. */
export const DEFAULT_TRASH_DAYS = 30;

export interface TrashItem {
  id: string,
  kind: "document" | "asset",
  /** Content type, for documents. */
  type: string | null,
  /** The document or asset ID it restores to. */
  itemId: string,
  /** Set when only one translation was deleted. */
  locale: string | null,
  label: string,
  deletedAt: string,
  deletedBy: string,
  /** When it's purged for good. */
  expiresAt: string
}

/** One document in one language, as the editor works on it. */
export interface DocumentState {
  id: string,
  type: string,
  locale: string,
  exists: boolean,
  locales: Array<{ locale: string, status: "draft" | "published" | "changed", updatedAt: string }>,
  draft: DocumentData | null,
  published: DocumentData | null,
  status: "draft" | "published" | "changed" | null,
  publishedVer: number | null,
  createdAt: string | null,
  updatedAt: number | null,
  updatedBy: string | null,
  publishedAt: string | null,
  schedules: Array<{ action: "publish" | "unpublish", runAt: string, ver: number | null, createdBy: string }>,
  fallback: DocumentData | null,
  issues?: Issue[]
}

/** A file in the media library, as the API returns it. */
export interface Asset {
  id: string,
  url: string,
  filename: string,
  folder: string | null,
  mime: string,
  size: number,
  meta: AssetMeta,
  createdAt: string,
  createdBy: string
}

/** What the Trash page previews: the file, or each deleted language's draft. */
export type TrashDetail = TrashItem & {
  asset?: Asset,
  documents?: Array<{ locale: string, status: DocumentMeta["status"], data: DocumentData, updatedAt: string }>
};

export interface MediaFolder {
  /** `"posts/covers"`; segments are separated by `/`. */
  path: string,
  /** Files directly in this folder, not in subfolders. */
  files: number
}

/** `" /posts//covers/ "` → `"posts/covers"`; empty → null (the root). Rejects names a directory couldn't have. */
export function normalizeFolder(input: string | null | undefined): string | null {
  if(input === null || input === undefined) return null;
  const segments = input.split("/").map(s => s.trim()).filter(Boolean);
  if(segments.length === 0) return null;
  for(const segment of segments) {
    if(segment === "." || segment === ".." || segment.length > 64 || segment.includes("\\") || [...segment].some(char => char.charCodeAt(0) < 32)) {
      throw new HttpError(400, `"${segment}" isn't a valid folder name`);
    }
  }
  if(segments.length > 12) throw new HttpError(400, "Folders nest at most 12 deep");
  return segments.join("/");
}

/** `"a/b/c"` → `["a", "a/b", "a/b/c"]`. */
function withAncestors(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
const HEX = /^#[0-9a-f]{6}$/i;

/** D1 caps bound parameters per statement at 100. */
const MAX_PARAMS = 90;

function chunks<T>(items: T[], size = MAX_PARAMS): T[][] {
  const out: T[][] = [];
  for(let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function unwrap(schema: AnySchema): AnySchema {
  return schema.type === "optional" ? (schema as OptionalSchema).inner : schema;
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export function documentStatus(row: Pick<DocumentRow, "draft" | "published">): DocumentMeta["status"] {
  if(row.published === null) return "draft";
  return row.published === row.draft ? "published" : "changed";
}

export class Engine {
  constructor(
    readonly state: EngineState,
    readonly scope: RequestScope
  ) {}

  get config() {
    return this.state.config;
  }

  get db() {
    return this.state.db;
  }

  private get locales(): string[] {
    return [...(this.config.locales ?? ["en"])];
  }

  private get defaultLocale(): string {
    return this.config.defaultLocale ?? this.locales[0]!;
  }

  private locale(locale: string | undefined): string {
    if(!locale) return this.defaultLocale;
    if(!this.locales.includes(locale)) throw new HttpError(400, `Unknown locale "${locale}"`);
    return locale;
  }

  /** `valid` says whether `doc` passed validation; the engine itself is type-erased. */
  private afterWrite(input: { type: string, id: string, locale: string, action: WriteAction | "delete", valid: boolean, doc: DocumentData | null }) {
    const promise = this.state.plugins.observe(input as Parameters<PluginHost["observe"]>[0]);
    if(this.scope.ctx) this.scope.ctx.waitUntil(promise);
    else return promise;
  }

  // --- Queries ---------------------------------------------------------------

  async execute(queries: SerializedQuery[]): Promise<unknown[]> {
    return Promise.all(queries.map(query => this.run(query)));
  }

  private async run(query: SerializedQuery): Promise<unknown> {
    const drafts = Boolean(query.drafts);
    if(drafts && !this.scope.trusted) require(this.config, this.scope.session, { action: "read", type: query.type });
    getSchema(this.config, query.type);
    const args = query.args ?? {};
    switch(query.op) {
      case "findMany":
        return this.find(query.type, args, drafts);
      case "findFirst":
        return (await this.find(query.type, { ...args, limit: 1 }, drafts))[0] ?? null;
      case "findById":
        if(typeof args.id !== "string") throw new HttpError(400, "findById needs an id");
        return (await this.find(query.type, { ...args, where: { op: "eq", path: ["id"], value: args.id }, limit: 1 }, drafts))[0] ?? null;
      case "count":
        return this.count(query.type, args, drafts);
      default:
        throw new HttpError(400, `Unknown query op "${(query as { op: string }).op}"`);
    }
  }

  /** Rows for a type in one locale, falling back to the default locale per document. */
  private source(type: string, locale: string, drafts: boolean): { sql: string, params: unknown[] } {
    const published = drafts ? "" : " AND d.published IS NOT NULL";
    if(locale === this.defaultLocale) {
      return { sql: `(SELECT d.* FROM vibe_documents d WHERE d.type = ? AND d.locale = ?${published})`, params: [type, locale] };
    }
    return {
      sql: `(SELECT * FROM (SELECT d.*, ROW_NUMBER() OVER (PARTITION BY d.id ORDER BY CASE d.locale WHEN ? THEN 0 ELSE 1 END) AS rn
        FROM vibe_documents d WHERE d.type = ? AND d.locale IN (?, ?)${published}) WHERE rn = 1)`,
      params: [locale, type, locale, this.defaultLocale]
    };
  }

  async count(type: string, args: QueryArgs, drafts: boolean): Promise<number> {
    const locale = this.locale(args.locale);
    const source = this.source(type, locale, drafts);
    const sql = new SqlBuilder(drafts ? "c.draft" : "c.published");
    const where = sql.where(args.where);
    const row = await first<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM ${source.sql} c WHERE ${where}`, [
      ...source.params,
      ...sql.params
    ]);
    return row?.n ?? 0;
  }

  async find(type: string, args: QueryArgs, drafts: boolean): Promise<Doc[]> {
    const locale = this.locale(args.locale);
    const source = this.source(type, locale, drafts);
    const sql = new SqlBuilder(drafts ? "c.draft" : "c.published");
    const where = sql.where(args.where);
    const order = sql.orderBy(args.orderBy, "c.updated_at DESC");
    const limit = Math.min(Math.max(args.limit ?? 100, 0), 1000);
    const rows = await all<DocumentRow>(
      this.db,
      `SELECT c.id, c.type, c.locale, c.draft, c.published, c.created_at, c.updated_at, c.published_at
       FROM ${source.sql} c WHERE ${where} ORDER BY ${order}, c.id LIMIT ? OFFSET ?`,
      [...source.params, ...sql.params, limit, Math.max(args.offset ?? 0, 0)]
    );
    const schema = getSchema(this.config, type);
    let docs = rows.map(row => this.toDoc(row, drafts));
    docs = await this.resolveAssets(schema, docs);
    if(args.with) await this.expand(type, docs, args.with, locale, drafts);
    if(this.state.plugins.has.read) {
      for(const doc of docs) {
        // The engine is type-erased: published reads are valid documents, drafts may not be.
        const output = { type, drafts, doc: doc as DocumentData } as HookArgs<"content.read">[1];
        await this.state.plugins.transform("content.read", { type, drafts }, output);
        Object.assign(doc, output.doc);
      }
    }
    return docs;
  }

  private toDoc(row: DocumentRow, drafts: boolean): Doc {
    const data = JSON.parse((drafts ? row.draft : row.published) ?? "{}") as DocumentData;
    return {
      ...data,
      id: row.id,
      $meta: {
        locale: row.locale,
        createdAt: iso(row.created_at)!,
        updatedAt: iso(row.updated_at)!,
        publishedAt: iso(row.published_at),
        status: documentStatus(row)
      }
    };
  }

  private async fetchByIds(type: string, ids: string[], locale: string, drafts: boolean, nested?: WithOptions["with"]) {
    const out = new Map<string, Doc>();
    for(const chunk of chunks([...new Set(ids)])) {
      const docs = await this.find(type, { where: { op: "in", path: ["id"], values: chunk }, locale, limit: 1000, with: nested }, drafts);
      for(const doc of docs) out.set(doc.id, doc);
    }
    return out;
  }

  private async expand(type: string, docs: Doc[], spec: Record<string, true | WithOptions>, locale: string, drafts: boolean) {
    if(docs.length === 0) return;
    const schema = getSchema(this.config, type);
    for(const [key, options] of Object.entries(spec)) {
      const opts: WithOptions = options === true ? {} : options;
      const field = schema.shape[key];
      if(field) {
        await this.expandForward(docs, key, unwrap(field), opts, locale, drafts);
        continue;
      }
      await this.expandReverse(type, docs, key, opts, locale, drafts);
    }
  }

  private async expandForward(docs: Doc[], key: string, field: AnySchema, opts: WithOptions, locale: string, drafts: boolean) {
    const isArray = field.type === "array";
    const ref = (isArray ? unwrap((field as ArraySchema).item) : field) as RefSchema;
    if(ref.type !== "ref") throw new HttpError(400, `"${key}" is not a reference field`);
    const byType = new Map<string, string[]>();
    function target(value: unknown): { type: string, id: string } | undefined {
      if(typeof value === "string" && ref.to) return { type: ref.to, id: value };
      if(value && typeof value === "object" && "id" in value && "type" in value) return value as { type: string, id: string };
      return undefined;
    }
    for(const doc of docs) {
      const values = isArray ? (doc[key] as unknown[] | undefined) ?? [] : [doc[key]];
      for(const value of values) {
        const t = target(value);
        if(t) byType.set(t.type, [...byType.get(t.type) ?? [], t.id]);
      }
    }
    const found = new Map<string, Doc>();
    for(const [type, ids] of byType) {
      if(!(type in this.config.schemas)) continue;
      for(const [id, doc] of await this.fetchByIds(type, ids, locale, drafts, opts.with)) found.set(id, doc);
    }
    for(const doc of docs) {
      if(isArray) {
        const values = (doc[key] as unknown[] | undefined) ?? [];
        doc[key] = values.map(v => found.get(target(v)?.id ?? "")).filter((d): d is Doc => d !== undefined);
      } else if(doc[key] !== undefined) {
        doc[key] = found.get(target(doc[key])?.id ?? "") ?? null;
      }
    }
  }

  private async expandReverse(type: string, docs: Doc[], key: string, opts: WithOptions, locale: string, drafts: boolean) {
    const source = key in this.config.schemas ? key : key.replace(/s$/, "");
    if(!(source in this.config.schemas)) throw new HttpError(400, `Can't expand "${key}": no field or content type by that name`);
    const sourceSchema = getSchema(this.config, source);
    const fields: Array<{ key: string, array: boolean }> = [];
    for(const [fieldKey, field] of Object.entries(sourceSchema.shape)) {
      const inner = unwrap(field);
      if(inner.type === "ref" && (inner as RefSchema).to === type) fields.push({ key: fieldKey, array: false });
      if(inner.type === "array") {
        const item = unwrap((inner as ArraySchema).item);
        if(item.type === "ref" && (item as RefSchema).to === type) fields.push({ key: fieldKey, array: true });
      }
    }
    if(fields.length === 0) throw new HttpError(400, `"${source}" has no reference to "${type}"`);
    const grouped = new Map<string, Doc[]>(docs.map(doc => [doc.id, []]));
    for(const chunk of chunks(docs.map(d => d.id), Math.floor(MAX_PARAMS / fields.length))) {
      const match: Condition = {
        op: "or",
        conditions: fields.flatMap((f): Condition[] => f.array
          ? chunk.map(id => ({ op: "has", path: [f.key], value: id }))
          : [{ op: "in", path: [f.key], values: chunk }])
      };
      const where: Condition = opts.where ? { op: "and", conditions: [match, opts.where] } : match;
      const related = await this.find(source, { where, orderBy: opts.orderBy, locale, limit: 1000, with: opts.with }, drafts);
      for(const doc of related) {
        for(const f of fields) {
          const value = doc[f.key];
          const ids = f.array ? (value as string[] | undefined) ?? [] : [value as string];
          for(const id of ids) {
            const list = grouped.get(id);
            if(list && !list.includes(doc)) list.push(doc);
          }
        }
      }
    }
    for(const doc of docs) {
      const list = grouped.get(doc.id) ?? [];
      doc[key] = opts.limit === undefined ? list : list.slice(0, opts.limit);
    }
  }

  private assetUrl(row: Pick<AssetRow, "id" | "filename" | "mime" | "meta">): string {
    // Media is cached as immutable, so edited content gets a new URL: `?v=` counts edits.
    const version = (JSON.parse(row.meta) as AssetMeta).version;
    const query = typeof version === "number" && version > 0 ? `?v=${version}` : "";
    return `${this.scope.origin}${this.state.prefix}/media/${row.id}.${extensionFor(row.mime, row.filename)}${query}`;
  }

  toAsset(row: AssetRow): Asset {
    const meta = JSON.parse(row.meta) as AssetMeta;
    return {
      id: row.id,
      url: this.assetUrl(row),
      filename: row.filename,
      folder: row.folder,
      mime: row.mime,
      size: row.size,
      meta,
      createdAt: iso(row.created_at)!,
      createdBy: row.created_by
    };
  }

  /** Merges asset records into `{ asset, ...fields }` values and adds a URL. */
  private async resolveAssets(schema: ObjectSchema, docs: Doc[]): Promise<Doc[]> {
    const ids = new Set<string>();
    for(const doc of docs) {
      for(const ref of findReferences(schema, doc)) {
        if(ref.kind === "asset") ids.add((ref.value as { asset: string }).asset);
      }
    }
    if(ids.size === 0) return docs;
    const rows = new Map<string, AssetRow>();
    for(const chunk of chunks([...ids])) {
      const found = await all<AssetRow>(this.db, `SELECT * FROM vibe_assets WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
      for(const row of found) rows.set(row.id, row);
    }
    const resolve = (value: unknown): unknown => {
      const usage = value as { asset: string };
      const row = rows.get(usage.asset);
      if(!row) return { ...usage, url: null };
      const meta = JSON.parse(row.meta) as AssetMeta;
      return { url: this.assetUrl(row), mime: row.mime, size: row.size, filename: row.filename, ...meta, meta, ...usage };
    };
    return docs.map(doc => mapAssets(schema, doc, resolve) as Doc);
  }

  // --- Documents (editor API) ------------------------------------------------

  async getRow(id: string, locale: string): Promise<DocumentRow | null> {
    return first<DocumentRow>(this.db, "SELECT * FROM vibe_documents WHERE id = ? AND locale = ?", [id, locale]);
  }

  /** The full editing state of one document in one locale. */
  async getDocument(type: string, id: string, localeInput?: string): Promise<DocumentState> {
    const locale = this.locale(localeInput);
    require(this.config, this.scope.session, { action: "read", type });
    const rows = await all<DocumentRow>(this.db, "SELECT * FROM vibe_documents WHERE id = ? AND type = ?", [id, type]);
    if(rows.length === 0) throw new HttpError(404, "Document not found");
    const row = rows.find(r => r.locale === locale);
    const schedules = await all<ScheduleRow>(this.db, "SELECT * FROM vibe_schedules WHERE id = ? AND locale = ?", [id, locale]);
    return {
      id,
      type,
      locale,
      exists: Boolean(row),
      locales: rows.map(r => ({ locale: r.locale, status: documentStatus(r), updatedAt: iso(r.updated_at)! })),
      draft: row ? JSON.parse(row.draft) : null,
      published: row?.published ? JSON.parse(row.published) : null,
      status: row ? documentStatus(row) : null,
      publishedVer: row?.published_ver ?? null,
      createdAt: iso(row?.created_at ?? null),
      updatedAt: row?.updated_at ?? null,
      updatedBy: row?.updated_by ?? null,
      publishedAt: iso(row?.published_at ?? null),
      schedules: schedules.map(s => ({ action: s.action, runAt: iso(s.run_at)!, ver: s.ver, createdBy: s.created_by })),
      // Lets a translator start from the default locale's copy.
      fallback: row ? null : JSON.parse((rows.find(r => r.locale === this.defaultLocale) ?? rows[0]!).draft)
    };
  }

  /** Lists documents for the editor: drafts, with status. */
  async listDocuments(type: string, args: { locale?: string, search?: string, limit?: number, offset?: number, orderBy?: Order[], status?: string }) {
    require(this.config, this.scope.session, { action: "read", type });
    const conditions: Condition[] = [];
    if(args.search) conditions.push({ op: "search", value: args.search });
    const where: Condition = { op: "and", conditions };
    const docs = await this.find(type, { where, locale: args.locale, limit: args.limit ?? 50, offset: args.offset, orderBy: args.orderBy }, true);
    const total = await this.count(type, { where, locale: args.locale }, true);
    return { docs, total };
  }

  async save(input: {
    type: string,
    id?: string,
    locale?: string,
    data: unknown,
    baseUpdatedAt?: number,
    publish?: boolean
  }) {
    const schema = getSchema(this.config, input.type);
    const locale = this.locale(input.locale);
    const session = this.writer({ action: "write", type: input.type, locale });
    if(input.publish) this.writer({ action: "publish", type: input.type, locale });
    const id = input.id ?? newId("doc");
    if(input.id && !/^[\w-]{1,64}$/.test(input.id)) throw new HttpError(400, "Invalid document ID");
    const existing = input.id ? await this.getRow(id, locale) : null;
    if(existing && existing.type !== input.type) throw new HttpError(409, "Document ID belongs to another type");
    if(input.id && !existing) {
      const other = await first<{ type: string }>(this.db, "SELECT type FROM vibe_documents WHERE id = ? LIMIT 1", [id]);
      if(other && other.type !== input.type) throw new HttpError(409, "Document ID belongs to another type");
    }
    if(existing && input.baseUpdatedAt !== undefined && existing.updated_at !== input.baseUpdatedAt) {
      throw new HttpError(409, "This document was changed by someone else. Reload to see their changes.", {
        updatedAt: existing.updated_at,
        updatedBy: existing.updated_by
      });
    }
    const action: WriteAction = existing ? "update" : "create";
    const { doc, issues } = await this.prepare(schema, input.type, id, locale, action, input.data, session);
    if(input.publish && issues.length) throw new HttpError(422, "Validation failed", { issues });
    // Strictly increasing, so `baseUpdatedAt` always detects a concurrent edit.
    const now = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
    const draft = JSON.stringify(doc);
    await run(
      this.db,
      `INSERT INTO vibe_documents (id, type, locale, draft, schema_hash, created_at, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id, locale) DO UPDATE SET draft = excluded.draft, schema_hash = excluded.schema_hash,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [id, input.type, locale, draft, this.state.schemaHash, now, now, session?.sub ?? null]
    );
    this.afterWrite({ type: input.type, id, locale, action, valid: issues.length === 0, doc });
    if(input.publish) return this.publish(input.type, id, locale);
    return { ...(await this.getDocument(input.type, id, locale)), issues };
  }

  private writer(permit: Parameters<typeof require>[2]): Session | null {
    if(this.scope.trusted && !this.scope.session) return null;
    return require(this.config, this.scope.session, permit);
  }

  /** Runs the write pipeline: beforeValidate → validate + integrity → beforeWrite. */
  private async prepare(
    schema: ObjectSchema,
    type: string,
    id: string,
    locale: string,
    action: WriteAction,
    data: unknown,
    session: Session | null
  ) {
    const hookInput = { type, id, locale, action, session: session ?? undefined };
    const input = { doc: structuredClone((data ?? {}) as DocumentData) };
    await this.state.plugins.transform("content.beforeValidate", hookInput, input);
    const first = validate<DocumentData>(schema, input.doc);
    const valid = first.issues.length === 0 && (await this.checkReferences(schema, first.value)).length === 0;
    const output = { type, valid, doc: first.value } as HookArgs<"content.beforeWrite">[1];
    try {
      await this.state.plugins.transform("content.beforeWrite", { ...hookInput, valid }, output);
    } catch (error) {
      if(error instanceof HttpError) throw error;
      throw new HttpError(422, (error as Error).message || "Rejected by a plugin");
    }
    // Plugins may only set fields the schema declares; validate their output too.
    const result = validate<DocumentData>(schema, output.doc);
    const issues = [...result.issues, ...await this.checkReferences(schema, result.value), ...await this.checkUnique(schema, type, id, locale, result.value)];
    return { doc: result.value, issues };
  }

  /** `unique: true` text fields: no other document of the type has the value in this locale, as a draft or published. */
  private async checkUnique(schema: ObjectSchema, type: string, id: string, locale: string, doc: DocumentData): Promise<Issue[]> {
    const issues: Issue[] = [];
    for(const [key, field] of Object.entries(schema.shape)) {
      const inner = unwrap(field);
      if(inner.type !== "text" || !(inner as TextSchema).unique) continue;
      const value = doc[key];
      if(typeof value !== "string" || value === "") continue;
      const path = jsonPath([key]);
      const taken = await first<{ id: string }>(
        this.db,
        `SELECT id FROM vibe_documents WHERE type = ? AND locale = ? AND id != ? AND (json_extract(draft, ${path}) = ? OR json_extract(published, ${path}) = ?) LIMIT 1`,
        [type, locale, id, value, value]
      );
      if(taken) issues.push({ path: [key], message: `Another document already uses “${value}”` });
    }
    return issues;
  }

  /** Every ref must point at an existing document of the right type; every asset must exist and fit its field. */
  async checkReferences(schema: AnySchema, value: unknown): Promise<Issue[]> {
    const found = findReferences(schema, value);
    if(found.length === 0) return [];
    const issues: Issue[] = [];
    const refIds = found.filter(f => f.kind === "ref").map(f => {
      const s = f.schema as RefSchema;
      return { ...f, id: s.to ? f.value as string : (f.value as { id: string }).id };
    });
    const types = new Map<string, string>();
    for(const chunk of chunks([...new Set(refIds.map(r => r.id))])) {
      const rows = await all<{ id: string, type: string }>(
        this.db,
        `SELECT DISTINCT id, type FROM vibe_documents WHERE id IN (${chunk.map(() => "?").join(",")})`,
        chunk
      );
      for(const row of rows) types.set(row.id, row.type);
    }
    for(const ref of refIds) {
      const actual = types.get(ref.id);
      const expected = (ref.schema as RefSchema).to;
      if(!actual) issues.push({ path: ref.path, message: "Referenced document does not exist" });
      else if(expected && actual !== expected) issues.push({ path: ref.path, message: `Must reference a ${expected}` });
    }
    const assets = found.filter(f => f.kind === "asset");
    const rows = new Map<string, AssetRow>();
    for(const chunk of chunks([...new Set(assets.map(a => (a.value as { asset: string }).asset))])) {
      const found = await all<AssetRow>(this.db, `SELECT * FROM vibe_assets WHERE id IN (${chunk.map(() => "?").join(",")})`, chunk);
      for(const row of found) rows.set(row.id, row);
    }
    for(const asset of assets) {
      const row = rows.get((asset.value as { asset: string }).asset);
      if(!row) {
        issues.push({ path: asset.path, message: "Asset does not exist" });
        continue;
      }
      const message = checkAsset(asset.schema as AssetSchema, row.mime, row.size, JSON.parse(row.meta));
      if(message) issues.push({ path: asset.path, message });
    }
    return issues;
  }

  async publish(type: string, id: string, localeInput?: string) {
    const locale = this.locale(localeInput);
    const session = this.writer({ action: "publish", type, locale });
    const row = await this.getRow(id, locale);
    if(!row || row.type !== type) throw new HttpError(404, "Document not found");
    const schema = getSchema(this.config, type);
    const { doc, issues } = await this.prepare(schema, type, id, locale, "publish", JSON.parse(row.draft), session);
    if(issues.length) throw new HttpError(422, "Fix the highlighted fields before publishing", { issues });
    const data = JSON.stringify(doc);
    const ver = await this.appendVersion(id, locale, data, session);
    const now = Math.max(Date.now(), row.updated_at + 1);
    await run(
      this.db,
      `UPDATE vibe_documents SET draft = ?, published = ?, published_ver = ?, published_at = ?, updated_at = ?, updated_by = ?
       WHERE id = ? AND locale = ?`,
      [data, data, ver, now, now, session?.sub ?? null, id, locale]
    );
    await run(this.db, "DELETE FROM vibe_schedules WHERE id = ? AND locale = ? AND action = 'publish'", [id, locale]);
    this.afterWrite({ type, id, locale, action: "publish", valid: true, doc });
    return { ...(await this.getDocument(type, id, locale)), issues: [] };
  }

  private async appendVersion(id: string, locale: string, data: string, session: Session | null): Promise<number> {
    const row = await first<{ ver: number }>(
      this.db,
      `INSERT INTO vibe_versions (id, locale, ver, data, author, created_at)
       SELECT ?, ?, COALESCE(MAX(ver), 0) + 1, ?, ?, ? FROM vibe_versions WHERE id = ? AND locale = ?
       RETURNING ver`,
      [id, locale, data, session?.sub ?? "system", Date.now(), id, locale]
    );
    return row!.ver;
  }

  async unpublish(type: string, id: string, localeInput?: string) {
    const locale = this.locale(localeInput);
    this.writer({ action: "publish", type, locale });
    const row = await this.getRow(id, locale);
    if(!row || row.type !== type) throw new HttpError(404, "Document not found");
    await run(this.db, "UPDATE vibe_documents SET published = NULL, published_ver = NULL, published_at = NULL WHERE id = ? AND locale = ?", [id, locale]);
    await run(this.db, "DELETE FROM vibe_schedules WHERE id = ? AND locale = ? AND action = 'unpublish'", [id, locale]);
    this.afterWrite({ type, id, locale, action: "unpublish", valid: false, doc: null });
    return this.getDocument(type, id, locale);
  }

  /** Documents whose draft or published copy mentions this ID. */
  async incomingReferences(id: string) {
    const rows = await all<{ id: string, type: string, locale: string }>(
      this.db,
      "SELECT id, type, locale FROM vibe_documents WHERE id != ? AND (draft LIKE ? OR published LIKE ?) LIMIT 20",
      [id, `%"${id}"%`, `%"${id}"%`]
    );
    return rows;
  }

  /** Moves the document (or one translation) to the trash. Its history stays until the trash is purged. */
  async delete(type: string, id: string, options: { force?: boolean, locale?: string } = {}) {
    const session = this.writer({ action: "delete", type });
    const exists = await first(this.db, "SELECT 1 FROM vibe_documents WHERE id = ? AND type = ?", [id, type]);
    if(!exists) throw new HttpError(404, "Document not found");
    if(options.locale && options.locale !== this.defaultLocale) {
      // Removing one translation only.
      const locale = this.locale(options.locale);
      const rows = await all<DocumentRow>(this.db, "SELECT * FROM vibe_documents WHERE id = ? AND locale = ?", [id, locale]);
      if(!rows.length) throw new HttpError(404, "Translation not found");
      const trash = this.trashStatement({ kind: "document", type, itemId: id, locale, label: this.documentLabel(type, rows), payload: rows, session });
      await this.db.batch([
        trash.statement,
        this.db.prepare("DELETE FROM vibe_documents WHERE id = ? AND locale = ?").bind(id, locale),
        this.db.prepare("DELETE FROM vibe_schedules WHERE id = ? AND locale = ?").bind(id, locale)
      ]);
      this.afterWrite({ type, id, locale, action: "delete", valid: false, doc: null });
      return { deleted: true, trash: trash.id };
    }
    if(!options.force) {
      const refs = await this.incomingReferences(id);
      if(refs.length) throw new HttpError(409, "Other documents reference this one", { references: refs });
    }
    const output: { cancel?: string } = {};
    await this.state.plugins.transform("content.beforeDelete", { type, id, session: session ?? undefined }, output);
    if(output.cancel) throw new HttpError(409, output.cancel);
    const rows = await all<DocumentRow>(this.db, "SELECT * FROM vibe_documents WHERE id = ?", [id]);
    const trash = this.trashStatement({ kind: "document", type, itemId: id, locale: null, label: this.documentLabel(type, rows), payload: rows, session });
    // Pending schedules are dropped: a restored document shouldn't publish itself on an old timetable.
    await this.db.batch([
      trash.statement,
      this.db.prepare("DELETE FROM vibe_documents WHERE id = ?").bind(id),
      this.db.prepare("DELETE FROM vibe_schedules WHERE id = ?").bind(id)
    ]);
    this.afterWrite({ type, id, locale: "*", action: "delete", valid: false, doc: null });
    return { deleted: true, trash: trash.id };
  }

  /** The title the editor would show, from the default locale's draft when it's there. */
  private documentLabel(type: string, rows: DocumentRow[]): string {
    const row = rows.find(r => r.locale === this.defaultLocale) ?? rows[0];
    if(!row) return "Untitled";
    const doc = JSON.parse(row.draft) as DocumentData;
    const shape = getSchema(this.config, type).shape;
    const configured = this.config.collections?.[type]?.title;
    const field = configured ?? ["title", "name", "label", "heading"].find(key => shape[key] && unwrap(shape[key]).type === "text")
      ?? Object.entries(shape).find(([, schema]) => unwrap(schema).type === "text")?.[0];
    const value = field ? doc[field] : undefined;
    return typeof value === "string" && value.trim() ? value.slice(0, 200) : "Untitled";
  }

  async versions(type: string, id: string, localeInput?: string) {
    const locale = this.locale(localeInput);
    require(this.config, this.scope.session, { action: "read", type });
    const rows = await all<Omit<VersionRow, "data">>(
      this.db,
      "SELECT id, locale, ver, author, created_at FROM vibe_versions WHERE id = ? AND locale = ? ORDER BY ver DESC LIMIT 200",
      [id, locale]
    );
    return rows.map(r => ({ ver: r.ver, author: r.author, createdAt: iso(r.created_at) }));
  }

  async version(type: string, id: string, localeInput: string | undefined, ver: number) {
    const locale = this.locale(localeInput);
    require(this.config, this.scope.session, { action: "read", type });
    const row = await first<VersionRow>(this.db, "SELECT * FROM vibe_versions WHERE id = ? AND locale = ? AND ver = ?", [id, locale, ver]);
    if(!row) throw new HttpError(404, "Version not found");
    return { ver: row.ver, author: row.author, createdAt: iso(row.created_at), data: JSON.parse(row.data) };
  }

  /** Restoring copies a snapshot into the working copy; it is not published until you publish. */
  async restore(type: string, id: string, localeInput: string | undefined, ver: number) {
    const { data } = await this.version(type, id, localeInput, ver);
    return this.save({ type, id, locale: localeInput, data });
  }

  async schedule(type: string, id: string, localeInput: string | undefined, action: "publish" | "unpublish", runAt: string) {
    const locale = this.locale(localeInput);
    const session = this.writer({ action: "publish", type, locale });
    const at = Date.parse(runAt);
    if(Number.isNaN(at)) throw new HttpError(400, "Invalid date");
    if(at < Date.now() - 60_000) throw new HttpError(400, "That time is in the past");
    const row = await this.getRow(id, locale);
    if(!row || row.type !== type) throw new HttpError(404, "Document not found");
    let ver: number | null = null;
    if(action === "publish") {
      // Snapshot now, so later edits to the draft aren't published by surprise.
      const schema = getSchema(this.config, type);
      const { doc, issues } = await this.prepare(schema, type, id, locale, "publish", JSON.parse(row.draft), session);
      if(issues.length) throw new HttpError(422, "Fix the highlighted fields before scheduling", { issues });
      ver = await this.appendVersion(id, locale, JSON.stringify(doc), session);
    }
    await run(
      this.db,
      `INSERT INTO vibe_schedules (id, locale, ver, action, run_at, created_by) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id, locale, action) DO UPDATE SET ver = excluded.ver, run_at = excluded.run_at, created_by = excluded.created_by`,
      [id, locale, ver, action, at, session?.sub ?? "system"]
    );
    return this.getDocument(type, id, locale);
  }

  async cancelSchedule(type: string, id: string, localeInput: string | undefined, action: "publish" | "unpublish") {
    const locale = this.locale(localeInput);
    this.writer({ action: "publish", type, locale });
    await run(this.db, "DELETE FROM vibe_schedules WHERE id = ? AND locale = ? AND action = ?", [id, locale, action]);
    return this.getDocument(type, id, locale);
  }

  /** Called from the `scheduled` handler. */
  async runSchedules(now = Date.now()): Promise<number> {
    const due = await all<ScheduleRow & { type: string }>(
      this.db,
      `SELECT s.*, d.type FROM vibe_schedules s JOIN vibe_documents d ON d.id = s.id AND d.locale = s.locale
       WHERE s.run_at <= ? ORDER BY s.run_at LIMIT 50`,
      [now]
    );
    for(const item of due) {
      if(item.action === "publish" && item.ver !== null) {
        await this.db.batch([
          this.db.prepare(
            `UPDATE vibe_documents SET published = (SELECT data FROM vibe_versions WHERE id = ? AND locale = ? AND ver = ?),
             published_ver = ?, published_at = ? WHERE id = ? AND locale = ?`
          ).bind(item.id, item.locale, item.ver, item.ver, now, item.id, item.locale),
          this.db.prepare("DELETE FROM vibe_schedules WHERE id = ? AND locale = ? AND action = 'publish'").bind(item.id, item.locale)
        ]);
        const row = await this.getRow(item.id, item.locale);
        this.afterWrite({ type: item.type, id: item.id, locale: item.locale, action: "publish", valid: Boolean(row?.published), doc: row?.published ? JSON.parse(row.published) as DocumentData : null });
      } else if(item.action === "unpublish") {
        await this.db.batch([
          this.db.prepare("UPDATE vibe_documents SET published = NULL, published_ver = NULL, published_at = NULL WHERE id = ? AND locale = ?")
            .bind(item.id, item.locale),
          this.db.prepare("DELETE FROM vibe_schedules WHERE id = ? AND locale = ? AND action = 'unpublish'").bind(item.id, item.locale)
        ]);
        this.afterWrite({ type: item.type, id: item.id, locale: item.locale, action: "unpublish", valid: false, doc: null });
      }
    }
    return due.length;
  }

  // --- Media -----------------------------------------------------------------

  private get storage(): R2 {
    if(!this.state.storage) throw new HttpError(501, "No `storage` binding: media uploads need an R2 bucket");
    return this.state.storage;
  }

  async upload(file: File, options: { folder?: string | null, type?: string, field?: string }) {
    const session = this.writer({ action: "write", scope: "media" });
    // Browsers send unknown types (often .md, .yaml, .csv) as octet-stream in multipart bodies.
    const sent = file.type && file.type !== "application/octet-stream" ? file.type : null;
    const mime = sent ?? mimeFor(file.name) ?? "application/octet-stream";
    let schema: AssetSchema | undefined;
    if(options.type && options.field) {
      const found = schemaAt(getSchema(this.config, options.type), options.field.split("."));
      const inner = found && unwrap(found);
      if(inner?.type !== "asset") throw new HttpError(400, `"${options.field}" is not an asset field`);
      schema = inner as AssetSchema;
    }
    const output = {
      filename: (file.name || "upload").replace(/[/\\]/g, "_").slice(0, 200),
      folder: normalizeFolder(options.folder ?? schema?.folder)
    } as { filename: string, folder: string | null, reject?: string };
    await this.state.plugins.transform("media.beforeUpload", { mime, size: file.size, session: session ?? undefined }, output);
    if(output.reject) throw new HttpError(422, output.reject);
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const meta: AssetMeta = mime.startsWith("image/") ? analyzeImage(head, mime) : {};
    for(const [pattern, analyze] of this.state.plugins.analyzers()) {
      if(mimeMatches(mime, [pattern])) Object.assign(meta, await analyze(head, mime));
    }
    if(schema) {
      const message = checkAsset(schema, mime, file.size, meta);
      if(message) throw new HttpError(422, message);
    }
    const id = newId("ast");
    const key = `assets/${id}`;
    await this.storage.put(key, file, { httpMetadata: { contentType: mime } });
    const row: AssetRow = {
      id,
      key,
      folder: normalizeFolder(output.folder),
      filename: output.filename,
      mime,
      size: file.size,
      meta: JSON.stringify(meta),
      created_at: Date.now(),
      created_by: session?.sub ?? "system"
    };
    await run(
      this.db,
      "INSERT INTO vibe_assets (id, key, folder, filename, mime, size, meta, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [row.id, row.key, row.folder, row.filename, row.mime, row.size, row.meta, row.created_at, row.created_by]
    );
    await this.touchFolder(row.folder);
    return this.toAsset(row);
  }

  async listAssets(options: { folder?: string, search?: string, accept?: string[], limit?: number, offset?: number }) {
    require(this.config, this.scope.session, { action: "read", scope: "media" });
    const conditions: string[] = [];
    const params: unknown[] = [];
    if(options.folder !== undefined) {
      conditions.push(options.folder === "" ? "folder IS NULL" : "folder = ?");
      if(options.folder !== "") params.push(options.folder);
    }
    if(options.search) {
      conditions.push("filename LIKE ?");
      params.push(`%${options.search}%`);
    }
    const accept = (options.accept ?? []).filter(a => a && a !== "*/*" && a !== "*");
    if(accept.length) {
      conditions.push(`(${accept.map(() => "mime LIKE ?").join(" OR ")})`);
      params.push(...accept.map(a => a.replace("*", "%")));
    }
    const where = conditions.length ? conditions.join(" AND ") : "1";
    const rows = await all<AssetRow>(this.db, `SELECT * FROM vibe_assets WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [
      ...params,
      Math.min(options.limit ?? 60, 200),
      options.offset ?? 0
    ]);
    const total = await first<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM vibe_assets WHERE ${where}`, params);
    const folders = await this.listFolders();
    return { assets: rows.map(r => this.toAsset(r)), total: total?.n ?? 0, folders: folders.map(f => f.path) };
  }

  // --- Folders ---------------------------------------------------------------

  private async touchFolder(path: string | null) {
    if(path) await run(this.db, "INSERT OR IGNORE INTO vibe_folders (path, created_at) VALUES (?, ?)", [path, Date.now()]);
  }

  /** Every folder: stored ones, ones files are in, and all their parents. */
  async listFolders(): Promise<MediaFolder[]> {
    require(this.config, this.scope.session, { action: "read", scope: "media" });
    const [stored, counts] = await Promise.all([
      all<{ path: string }>(this.db, "SELECT path FROM vibe_folders"),
      all<{ folder: string, n: number }>(this.db, "SELECT folder, COUNT(*) AS n FROM vibe_assets WHERE folder IS NOT NULL GROUP BY folder")
    ]);
    const files = new Map(counts.map(c => [c.folder, c.n]));
    const paths = new Set<string>();
    for(const path of [...stored.map(s => s.path), ...files.keys()]) withAncestors(path).forEach(p => paths.add(p));
    return [...paths].sort((a, b) => a.localeCompare(b)).map(path => ({ path, files: files.get(path) ?? 0 }));
  }

  async createFolder(input: string): Promise<MediaFolder> {
    this.writer({ action: "write", scope: "media" });
    const path = normalizeFolder(input);
    if(!path) throw new HttpError(400, "Name the folder");
    await this.touchFolder(path);
    return { path, files: 0 };
  }

  /** Renames or moves a folder with everything in it. */
  async moveFolder(fromInput: string, toInput: string): Promise<{ path: string }> {
    this.writer({ action: "write", scope: "media" });
    const from = normalizeFolder(fromInput);
    const to = normalizeFolder(toInput);
    if(!from || !to) throw new HttpError(400, "Both folders need a name");
    if(from === to) return { path: to };
    if(to.startsWith(`${from}/`)) throw new HttpError(400, "A folder can't move into itself");
    const existing = await this.listFolders();
    if(!existing.some(f => f.path === from)) throw new HttpError(404, "Folder not found");
    if(existing.some(f => f.path === to)) throw new HttpError(409, `There's already a folder called "${to}"`);
    // Prefix compare rather than LIKE, so `%` and `_` in names stay literal.
    const prefix = `${from}/`;
    await run(
      this.db,
      "UPDATE vibe_assets SET folder = ? || substr(folder, ?) WHERE folder = ? OR substr(folder, 1, ?) = ?",
      [to, from.length + 1, from, prefix.length, prefix]
    );
    await run(
      this.db,
      "UPDATE vibe_folders SET path = ? || substr(path, ?) WHERE path = ? OR substr(path, 1, ?) = ?",
      [to, from.length + 1, from, prefix.length, prefix]
    );
    await this.touchFolder(to);
    return { path: to };
  }

  /** Only empty folders: files have to be moved or deleted first, so nothing disappears by surprise. */
  async deleteFolder(input: string): Promise<{ deleted: true }> {
    this.writer({ action: "delete", scope: "media" });
    const path = normalizeFolder(input);
    if(!path) throw new HttpError(400, "Name the folder");
    const prefix = `${path}/`;
    const used = await first(this.db, "SELECT 1 FROM vibe_assets WHERE folder = ? OR substr(folder, 1, ?) = ? LIMIT 1", [path, prefix.length, prefix]);
    if(used) throw new HttpError(409, "This folder still has files in it");
    await run(this.db, "DELETE FROM vibe_folders WHERE path = ? OR substr(path, 1, ?) = ?", [path, prefix.length, prefix]);
    return { deleted: true };
  }

  async getAsset(id: string) {
    require(this.config, this.scope.session, { action: "read", scope: "media" });
    const row = await first<AssetRow>(this.db, "SELECT * FROM vibe_assets WHERE id = ?", [id]);
    if(!row) throw new HttpError(404, "Asset not found");
    const usage = await all<{ id: string, type: string, locale: string }>(
      this.db,
      "SELECT id, type, locale FROM vibe_documents WHERE draft LIKE ? OR published LIKE ? LIMIT 50",
      [`%"${id}"%`, `%"${id}"%`]
    );
    return { ...this.toAsset(row), usage };
  }

  async updateAsset(id: string, patch: { folder?: string | null, filename?: string }) {
    this.writer({ action: "write", scope: "media" });
    const row = await first<AssetRow>(this.db, "SELECT * FROM vibe_assets WHERE id = ?", [id]);
    if(!row) throw new HttpError(404, "Asset not found");
    const folder = patch.folder === undefined ? row.folder : normalizeFolder(patch.folder);
    const filename = patch.filename?.trim().replace(/[/\\]/g, "_").slice(0, 200) || row.filename;
    await this.touchFolder(folder);
    await run(this.db, "UPDATE vibe_assets SET folder = ?, filename = ? WHERE id = ?", [folder, filename, id]);
    return this.toAsset({ ...row, folder, filename });
  }

  /** Replaces a text file's content in place; the asset keeps its ID, so documents still point at it. */
  async replaceContent(id: string, content: ArrayBuffer) {
    this.writer({ action: "write", scope: "media" });
    const row = await first<AssetRow>(this.db, "SELECT * FROM vibe_assets WHERE id = ?", [id]);
    if(!row) throw new HttpError(404, "Asset not found");
    if(!textKind(row.filename, row.mime)) throw new HttpError(415, "Only text files can be edited");
    if(content.byteLength > MAX_TEXT_EDIT_BYTES) throw new HttpError(413, "Text files can be edited up to 1 MB");
    await this.storage.put(row.key, content, { httpMetadata: { contentType: row.mime } });
    const meta = JSON.parse(row.meta) as AssetMeta;
    const next = JSON.stringify({ ...meta, version: (typeof meta.version === "number" ? meta.version : 0) + 1, editedAt: new Date().toISOString() });
    await run(this.db, "UPDATE vibe_assets SET size = ?, meta = ? WHERE id = ?", [content.byteLength, next, id]);
    return this.toAsset({ ...row, size: content.byteLength, meta: next });
  }

  async deleteAsset(id: string) {
    const session = this.writer({ action: "delete", scope: "media" });
    const row = await first<AssetRow>(this.db, "SELECT * FROM vibe_assets WHERE id = ?", [id]);
    if(!row) throw new HttpError(404, "Asset not found");
    const used = await first(this.db, "SELECT 1 FROM vibe_documents WHERE draft LIKE ? OR published LIKE ? LIMIT 1", [
      `%"${id}"%`,
      `%"${id}"%`
    ]);
    if(used) throw new HttpError(409, "This file is used by a document");
    if((await this.storedSite()).icon === id) throw new HttpError(409, "This file is the site's icon");
    // The R2 object stays until the trash is purged, so restoring brings back the same URL.
    const trash = this.trashStatement({ kind: "asset", type: null, itemId: id, locale: null, label: row.filename, payload: row, session });
    await this.db.batch([trash.statement, this.db.prepare("DELETE FROM vibe_assets WHERE id = ?").bind(id)]);
    return { deleted: true, trash: trash.id };
  }

  // --- Trash -------------------------------------------------------------------

  private get trashDays(): number {
    return this.config.trash?.days ?? DEFAULT_TRASH_DAYS;
  }

  private trashStatement(input: {
    kind: TrashRow["kind"],
    type: string | null,
    itemId: string,
    locale: string | null,
    label: string,
    payload: unknown,
    session: Session | null
  }) {
    const id = newId("trs");
    const statement = this.db.prepare(
      "INSERT INTO vibe_trash (id, kind, type, item_id, locale, label, payload, deleted_at, deleted_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, input.kind, input.type, input.itemId, input.locale, input.label, JSON.stringify(input.payload), Date.now(), input.session?.sub ?? "system");
    return { id, statement };
  }

  /** Whether the session may see, restore and purge this item: the same permission that deleted it. */
  private canTrash(row: Pick<TrashRow, "kind" | "type">): boolean {
    if(this.scope.trusted && !this.scope.session) return true;
    return can(this.config, this.scope.session, row.kind === "asset" ? { action: "delete", scope: "media" } : { action: "delete", type: row.type ?? undefined });
  }

  private toTrashItem(row: TrashRow): TrashItem {
    return {
      id: row.id,
      kind: row.kind,
      type: row.type,
      itemId: row.item_id,
      locale: row.locale,
      label: row.label,
      deletedAt: iso(row.deleted_at)!,
      deletedBy: row.deleted_by,
      expiresAt: iso(row.deleted_at + this.trashDays * 86_400_000)!
    };
  }

  /** Newest first, only what this session may restore. Types no longer in the config are skipped. */
  async listTrash(): Promise<{ items: TrashItem[], days: number }> {
    if(!this.scope.trusted && !this.scope.session) throw new HttpError(401, "Sign in required");
    const rows = await all<TrashRow>(this.db, "SELECT * FROM vibe_trash ORDER BY deleted_at DESC LIMIT 500");
    const known = (row: TrashRow) => row.kind === "asset" || (row.type !== null && row.type in this.config.schemas);
    return { items: rows.filter(row => known(row) && this.canTrash(row)).map(row => this.toTrashItem(row)), days: this.trashDays };
  }

  private async trashRow(id: string): Promise<TrashRow> {
    if(!this.scope.trusted && !this.scope.session) throw new HttpError(401, "Sign in required");
    const row = await first<TrashRow>(this.db, "SELECT * FROM vibe_trash WHERE id = ?", [id]);
    if(!row || !this.canTrash(row)) throw new HttpError(404, "Not in the trash");
    return row;
  }

  /** What the Trash page previews: each deleted language's draft, or the file's details. */
  async trashDetail(id: string): Promise<TrashDetail> {
    const row = await this.trashRow(id);
    const item = this.toTrashItem(row);
    if(row.kind === "asset") {
      const asset = this.toAsset(JSON.parse(row.payload) as AssetRow);
      // Its public URL 404s while trashed; the editor fetches the bytes from here instead.
      return { ...item, asset: { ...asset, url: `${this.scope.origin}${this.state.prefix}/api/trash/${row.id}/file` } };
    }
    const docs = JSON.parse(row.payload) as DocumentRow[];
    return {
      ...item,
      documents: docs.map(d => ({ locale: d.locale, status: documentStatus(d), data: JSON.parse(d.draft) as DocumentData, updatedAt: iso(d.updated_at)! }))
    };
  }

  /** A trashed file's bytes, for signed-in editors who may restore it. */
  async trashFile(id: string): Promise<Response> {
    const row = await this.trashRow(id);
    if(row.kind !== "asset") throw new HttpError(404, "Not a file");
    const asset = JSON.parse(row.payload) as AssetRow;
    const object = await this.storage.get(asset.key);
    if(!object) throw new HttpError(404, "The file's content is gone");
    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff"
    });
    if(headers.get("content-type") === "image/svg+xml") headers.set("content-security-policy", "script-src 'none'");
    return new Response(object.body, { headers });
  }

  /** Puts the item back exactly as it was deleted, published state included. */
  async restoreTrash(id: string): Promise<TrashItem & { restored: true }> {
    const row = await this.trashRow(id);
    if(row.kind === "asset") {
      const asset = JSON.parse(row.payload) as AssetRow;
      if(await first(this.db, "SELECT 1 FROM vibe_assets WHERE id = ?", [asset.id])) throw new HttpError(409, "That file already exists");
      await this.db.batch([
        this.db.prepare("INSERT INTO vibe_assets (id, key, folder, filename, mime, size, meta, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(asset.id, asset.key, asset.folder, asset.filename, asset.mime, asset.size, asset.meta, asset.created_at, asset.created_by),
        this.db.prepare("DELETE FROM vibe_trash WHERE id = ?").bind(id)
      ]);
      await this.touchFolder(asset.folder);
      return { ...this.toTrashItem(row), restored: true };
    }
    const type = row.type!;
    getSchema(this.config, type);
    const docs = JSON.parse(row.payload) as DocumentRow[];
    if(row.locale && !(await first(this.db, "SELECT 1 FROM vibe_documents WHERE id = ?", [row.item_id]))) {
      throw new HttpError(409, "Restore the document itself first; this is only one of its translations");
    }
    const taken = await all<{ locale: string }>(this.db, "SELECT locale FROM vibe_documents WHERE id = ?", [row.item_id]);
    if(taken.some(t => docs.some(d => d.locale === t.locale))) throw new HttpError(409, "A document with this ID and language exists again");
    // Files it used that were deleted since come back with it, so its references still resolve.
    const files = await all<TrashRow>(this.db, "SELECT * FROM vibe_trash WHERE kind = 'asset'");
    const used = files.filter(file => docs.some(d => d.draft.includes(`"${file.item_id}"`) || d.published?.includes(`"${file.item_id}"`)));
    const columns = ["id", "type", "locale", "draft", "published", "published_ver", "schema_hash", "created_at", "updated_at", "published_at", "updated_by"] as const;
    await this.db.batch([
      ...docs.map(d => this.db.prepare(`INSERT INTO vibe_documents (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).bind(...columns.map(c => d[c]))),
      this.db.prepare("DELETE FROM vibe_trash WHERE id = ?").bind(id)
    ]);
    for(const file of used) {
      if(this.canTrash(file)) await this.restoreTrash(file.id).catch(() => {});
    }
    for(const d of docs) this.afterWrite({ type, id: row.item_id, locale: d.locale, action: "restore", valid: false, doc: null });
    return { ...this.toTrashItem(row), restored: true };
  }

  /** Deletes for good: the row, the document's history or the file's bytes. */
  async purgeTrash(id: string): Promise<{ purged: true }> {
    await this.purge(await this.trashRow(id));
    return { purged: true };
  }

  /** Purges everything this session may see, or (from cron) everything past its retention. */
  async emptyTrash(options: { olderThan?: number } = {}): Promise<{ purged: number }> {
    const rows = options.olderThan === undefined
      ? await all<TrashRow>(this.db, "SELECT * FROM vibe_trash")
      : await all<TrashRow>(this.db, "SELECT * FROM vibe_trash WHERE deleted_at < ? LIMIT 200", [options.olderThan]);
    let purged = 0;
    for(const row of rows) {
      if(!this.canTrash(row)) continue;
      await this.purge(row);
      purged++;
    }
    return { purged };
  }

  /** Called from the `scheduled` handler. */
  async purgeExpiredTrash(now = Date.now()): Promise<number> {
    return (await this.emptyTrash({ olderThan: now - this.trashDays * 86_400_000 })).purged;
  }

  private async purge(row: TrashRow) {
    if(row.kind === "asset") {
      const asset = JSON.parse(row.payload) as AssetRow;
      // Restored and deleted again leaves two trash rows for one object; only the last one out deletes it.
      const live = await first(this.db, "SELECT 1 FROM vibe_assets WHERE id = ? UNION ALL SELECT 1 FROM vibe_trash WHERE item_id = ? AND id != ?", [asset.id, asset.id, row.id]);
      if(!live && this.state.storage) await this.state.storage.delete(asset.key);
      await run(this.db, "DELETE FROM vibe_trash WHERE id = ?", [row.id]);
      return;
    }
    const docs = JSON.parse(row.payload) as DocumentRow[];
    const statements = [this.db.prepare("DELETE FROM vibe_trash WHERE id = ?").bind(row.id)];
    for(const { locale } of docs) {
      // History goes only when nothing else still needs it: no live row and no other trash entry for that language.
      statements.push(this.db.prepare(
        `DELETE FROM vibe_versions WHERE id = ? AND locale = ?
         AND NOT EXISTS (SELECT 1 FROM vibe_documents WHERE id = ? AND locale = ?)
         AND NOT EXISTS (SELECT 1 FROM vibe_trash WHERE item_id = ? AND id != ? AND payload LIKE ?)`
      ).bind(row.item_id, locale, row.item_id, locale, row.item_id, row.id, `%"locale":"${locale}"%`));
    }
    await this.db.batch(statements);
  }

  // --- Site settings ------------------------------------------------------------

  private async storedSite(): Promise<StoredSite> {
    const raw = await getMeta(this.db, SITE_KEY);
    if(!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed as StoredSite : {};
  }

  /** Public: the panel shows sites by these before anyone signs in. */
  async site(fallbackName: string): Promise<SiteSettings> {
    const stored = await this.storedSite();
    const row = stored.icon ? await first<AssetRow>(this.db, "SELECT * FROM vibe_assets WHERE id = ?", [stored.icon]) : null;
    return {
      name: stored.name ?? this.config.name ?? fallbackName,
      accent: stored.accent ?? null,
      icon: row ? { id: row.id, url: this.assetUrl(row) } : null
    };
  }

  async updateSite(patch: SiteSettingsPatch, fallbackName: string): Promise<SiteSettings> {
    if(!this.scope.trusted || this.scope.session) require(this.config, this.scope.session, { action: "write", scope: "site" });
    const next = await this.storedSite();
    if(patch.name !== undefined) {
      const name = patch.name.trim();
      if(!name || name.length > 80) throw new HttpError(400, "The name needs 1-80 characters");
      // Matching the code's name means "no override", so changing the config later still shows through.
      if(name === this.config.name) delete next.name;
      else next.name = name;
    }
    if(patch.accent !== undefined) {
      if(patch.accent === null) delete next.accent;
      else if(HEX.test(patch.accent)) next.accent = patch.accent.toLowerCase();
      else throw new HttpError(400, "accent must be a #rrggbb color");
    }
    if(patch.icon !== undefined) {
      if(patch.icon === null) {
        delete next.icon;
      } else {
        const row = await first<AssetRow>(this.db, "SELECT * FROM vibe_assets WHERE id = ?", [patch.icon]);
        if(!row) throw new HttpError(400, "Icon asset not found");
        if(!row.mime.startsWith("image/")) throw new HttpError(400, "The icon has to be an image");
        next.icon = row.id;
      }
    }
    await run(this.db, "INSERT INTO vibe_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [
      SITE_KEY,
      JSON.stringify(next)
    ]);
    return this.site(fallbackName);
  }

  async serveAsset(file: string, request: Request): Promise<Response> {
    const id = file.replace(/\.[a-z0-9]+$/i, "");
    // Trashed files keep their bytes in R2 but aren't served.
    if(!(await first(this.db, "SELECT 1 FROM vibe_assets WHERE id = ?", [id]))) return new Response("Not found", { status: 404 });
    const object = await this.storage.get(`assets/${id}`);
    if(!object) return new Response("Not found", { status: 404 });
    const headers = new Headers({
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff"
    });
    if(headers.get("content-type") === "image/svg+xml") headers.set("content-security-policy", "script-src 'none'");
    if(request.headers.get("if-none-match") === object.httpEtag) return new Response(null, { status: 304, headers });
    return new Response(object.body, { headers });
  }

  /** Whether the current session may do something; exposed for plugin routes. */
  can(permit: Parameters<typeof can>[2]): boolean {
    return can(this.config, this.scope.session, permit);
  }
}

export function checkAsset(schema: AssetSchema, mime: string, size: number, meta: AssetMeta): string | undefined {
  if(!mimeMatches(mime, schema.accept)) return `File type ${mime} isn't accepted here`;
  const max = schema.maxSize === undefined ? undefined : parseSize(schema.maxSize);
  if(max !== undefined && size > max) return `File is larger than ${formatBytes(max)}`;
  if(schema.validate) {
    const result = schema.validate({ ...meta, mime, size });
    if(result !== true) return typeof result === "string" ? result : "File doesn't meet this field's requirements";
  }
  return undefined;
}

export function formatBytes(bytes: number): string {
  if(bytes >= 1e9) return `${+(bytes / 1e9).toFixed(1)} GB`;
  if(bytes >= 1e6) return `${+(bytes / 1e6).toFixed(1)} MB`;
  if(bytes >= 1e3) return `${+(bytes / 1e3).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Rebuilds a value with every asset usage passed through `fn`. */
export function mapAssets(schema: AnySchema, value: unknown, fn: (value: unknown) => unknown): unknown {
  if(value === undefined || value === null) return value;
  switch(schema.type) {
    case "optional":
      return mapAssets((schema as OptionalSchema).inner, value, fn);
    case "asset": {
      const fields = (schema as AssetSchema).fields;
      const inner: { [key: string]: unknown } = { ...(isRecord(value) ? value : {}) };
      for(const [key, field] of Object.entries(fields)) inner[key] = mapAssets(field, inner[key], fn);
      return fn(inner);
    }
    case "array":
      return Array.isArray(value) ? value.map(item => mapAssets((schema as ArraySchema).item, item, fn)) : value;
    case "object": {
      if(!isRecord(value)) return value;
      const out: { [key: string]: unknown } = { ...value };
      for(const [key, field] of Object.entries((schema as ObjectSchema).shape)) {
        if(key in out) out[key] = mapAssets(field, out[key], fn);
      }
      return out;
    }
    case "union": {
      const option = pickUnionOption(schema as UnionSchema, value);
      return option ? mapAssets(option, value, fn) : value;
    }
    default:
      return value;
  }
}
