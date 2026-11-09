import { getSchema, HttpError, type AnyConfig } from "../config.ts";
import type { SiteOrg } from "./org.ts";
import type { RoleStore } from "./roles.ts";
import type { SignInConfig } from "./signin.ts";
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
import { findReferences, isAssetValue, isRecord, pickUnionOption, schemaAt, shapeMismatches, validate, type Issue } from "../schema/validate.ts";
import type { Session, WriteAction } from "../server/index.ts";
import { analyzeImage, extensionFor, mimeFor, mimeMatches } from "./analyze.ts";
import { can, require, type Permit } from "./auth.ts";
import { detectFavicon, type SiteFetch } from "./favicon.ts";
import { and, count, desc, eq, inArray, isNotNull, isNull, like, lte, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb } from "../db/client.ts";
import { assets, documents, folders, meta, schedules, trash, versions, type AssetRow, type DocumentRow, type ScheduleRow, type TrashRow, type VersionRow } from "../db/schema.ts";
import { all, first, getMeta, newId } from "./db.ts";
import type { D1, ExecutionContext, ImagesBinding, R2 } from "./platform.ts";
import { serveTransformed, type ImageHealth } from "./images.ts";
import { hasMetadataSupport, stripMetadata } from "../media/metadata.ts";
import type { HookArgs, PluginHost } from "./plugins.ts";
import { ftsQuery, jsonPath, searchWords, SqlBuilder } from "./sql.ts";

/** Where a search hit the body, words between \u0001 and \u0002. */
const SNIPPET = "snippet(vibe_search, 4, char(1), char(2), '…', 12)";

/** A search hit's body excerpt, or null when its title already shows every word matched. */
function bodyExcerpt(row: { title: string | null, excerpt: string | null }, query: string): string | null {
  const titleWords = searchWords(row.title ?? "");
  const inTitle = searchWords(query).every(word => titleWords.some(t => t.startsWith(word)));
  return inTitle || !row.excerpt?.includes("\u0001") ? null : row.excerpt;
}
import { MAX_TEXT_EDIT_BYTES, textKind } from "../text-files.ts";

export interface EngineState {
  config: AnyConfig,
  db: D1,
  storage: R2 | undefined,
  /** Cloudflare's Images binding; `false` when the site opted out of optimization. */
  images?: ImagesBinding | false,
  /** Whether optimization is working, for warnings. */
  imageHealth?: ImageHealth,
  plugins: PluginHost,
  schemaHash: string,
  prefix: string,
  /** Random, made on first boot and kept in the database: the site's identity to panels and in session tokens. */
  siteId: string,
  /** The site's stored roles; `can()` reads them. */
  roles: RoleStore,
  /** The org whose hub the site trusts (`VIBE_ORG`), and moves to another. */
  org: SiteOrg,
  /** How the site signs people in when it has no org: its identity provider, or passkeys; and its email sender. */
  signIn: SignInConfig,
  /** The site's own pages, for finding its favicon. */
  siteFetch?: SiteFetch
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

/** How the site presents itself in the editor and the panel, as editors set it on the Site page. */
export interface SiteSettings {
  id: string,
  /** The saved name, else the host name. */
  name: string,
  /** `#rrggbb`, or null for the neutral default. */
  accent: string | null,
  /** The icon chosen on the Site page. */
  icon: { id: string, url: string } | null,
  /** The site's own favicon, found on its home page. Shown when no icon is chosen. */
  favicon: string | null,
  /**
   * Whether uploads lose their location and camera details, keeping orientation. The editor asks
   * when a photo has them, suggesting this; uploads from the CLI and agents follow it. Default true.
   */
  stripMetadata: boolean
}

export interface SiteSettingsPatch {
  name?: string,
  accent?: string | null,
  /** Asset ID; null removes the icon. */
  icon?: string | null,
  stripMetadata?: boolean
}

interface StoredSite {
  name?: string,
  accent?: string,
  icon?: string,
  /** Only stored when turned off. */
  stripMetadata?: false
}

/** What the CMS has seen of the site from its requests, refreshed daily. */
interface DetectedSite {
  host: string,
  /** Root-relative when it's on the site itself. */
  favicon: string | null,
  checked: number
}

/** What `readAsset` reads without being told a larger limit. */
const READ_ASSET_MAX_BYTES = 10 * 1024 * 1024;

const SITE_KEY = "site";
const DETECTED_KEY = "site_detected";
const DETECT_EVERY = 24 * 60 * 60 * 1000;
// Sooner when there was none, so a favicon added in development shows up.
const DETECT_NONE_EVERY = 5 * 60 * 1000;
const detecting = new WeakMap<D1, Promise<DetectedSite | null>>();

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

/** `mime LIKE` for a list of accepted types (`image/*`, `application/pdf`); undefined when any type will do. */
function mimeCondition(accept: string[] | undefined): SQL | undefined {
  const types = (accept ?? []).filter(a => a && a !== "*/*" && a !== "*");
  return types.length ? or(...types.map(a => like(assets.mime, a.replace("*", "%")))) : undefined;
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

  /** The typed query builder over the site's D1. */
  private get orm() {
    return createDb(this.db);
  }

  /** `db.batch` wants a non-empty tuple; every caller passes at least one statement. */
  private batch(items: Array<BatchItem<"sqlite">>) {
    return this.orm.batch(items as [BatchItem<"sqlite">, ...Array<BatchItem<"sqlite">>]);
  }

  private async putMeta(key: string, value: string) {
    await this.orm.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } });
  }

  private async assetsByIds(ids: string[]): Promise<AssetRow[]> {
    return this.orm.select().from(assets).where(inArray(assets.id, ids));
  }

  private async assetRow(id: string): Promise<AssetRow | null> {
    return (await this.orm.select().from(assets).where(eq(assets.id, id)).limit(1))[0] ?? null;
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
    if(drafts && !this.scope.trusted) require(this.state, this.scope.session, { action: "read", type: query.type });
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
    // Drafts may be invalid by design; a published copy that doesn't fit was stored under an older schema.
    if(!drafts) checkStoredShape(type, schema, docs);
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
      const found = await this.assetsByIds(chunk);
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
    return (await this.orm.select().from(documents).where(and(eq(documents.id, id), eq(documents.locale, locale))).limit(1))[0] ?? null;
  }

  /** The full editing state of one document in one locale. */
  async getDocument(type: string, id: string, localeInput?: string): Promise<DocumentState> {
    const locale = this.locale(localeInput);
    require(this.state, this.scope.session, { action: "read", type });
    const rows = await this.orm.select().from(documents).where(and(eq(documents.id, id), eq(documents.type, type)));
    if(rows.length === 0) throw new HttpError(404, "Document not found");
    const row = rows.find(r => r.locale === locale);
    const pending = await this.orm.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.locale, locale)));
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
      schedules: pending.map(s => ({ action: s.action, runAt: iso(s.run_at)!, ver: s.ver, createdBy: s.created_by })),
      // Lets a translator start from the default locale's copy.
      fallback: row ? null : JSON.parse((rows.find(r => r.locale === this.defaultLocale) ?? rows[0]!).draft)
    };
  }

  /**
   * Lists documents for the editor: drafts, with status. With `search`, only full-text matches, plus
   * `all` (the unfiltered count) and an excerpt for each match the title doesn't explain.
   */
  async listDocuments(type: string, args: { locale?: string, search?: string, limit?: number, offset?: number, orderBy?: Order[], status?: string }) {
    require(this.state, this.scope.session, { action: "read", type });
    const searching = searchWords(args.search ?? "").length > 0;
    const where: Condition = { op: "and", conditions: searching ? [{ op: "fulltext", value: args.search! }] : [] };
    const limit = args.limit ?? 50;
    let docs;
    if(searching && !args.orderBy?.length) {
      // Best matches first: rank in the index, then load that page. A document counts in the locale
      // shown or, untranslated, the default one, as `find` falls back.
      const offset = Math.max(args.offset ?? 0, 0);
      const ranked = await all<{ id: string }>(this.db,
        `SELECT id FROM vibe_search WHERE vibe_search MATCH ? AND type = ? AND locale IN (?, ?)
          ORDER BY bm25(vibe_search, 0, 0, 0, 10, 1), id LIMIT ?`,
        // At most two rows per document, so twice the page covers it.
        [ftsQuery(args.search!), type, this.locale(args.locale), this.defaultLocale, (offset + limit) * 2]);
      const ids = [...new Set(ranked.map(row => row.id))].slice(offset, offset + limit);
      const found = ids.length ? await this.find(type, { where: { op: "in", path: ["id"], values: ids }, locale: args.locale, limit }, true) : [];
      docs = ids.flatMap(id => found.filter(doc => doc.id === id));
    } else {
      docs = await this.find(type, { where, locale: args.locale, limit, offset: args.offset, orderBy: args.orderBy }, true);
    }
    const total = await this.count(type, { where, locale: args.locale }, true);
    if(!searching) return { docs, total, all: total, excerpts: {} };
    const unfiltered = await this.count(type, { locale: args.locale }, true);
    const excerpts: Record<string, string> = {};
    if(docs.length) {
      const rows = await all<{ id: string, title: string | null, excerpt: string | null }>(this.db,
        `SELECT id, title, ${SNIPPET} AS excerpt FROM vibe_search
          WHERE vibe_search MATCH ? AND id IN (${docs.map(() => "?").join(", ")}) AND locale IN (?, ?)
          ORDER BY locale = ? DESC`,
        [ftsQuery(args.search!), ...docs.map(doc => doc.id), this.locale(args.locale), this.defaultLocale, this.locale(args.locale)]);
      for(const row of rows) {
        const excerpt = bodyExcerpt(row, args.search!);
        if(excerpt && !(row.id in excerpts)) excerpts[row.id] = excerpt;
      }
    }
    return { docs, total, all: unfiltered, excerpts };
  }

  /**
   * Full-text search over every content type the session can read, in one locale, best matches first.
   * Each word matches as a prefix, so results follow typing. Titles weigh more than body text; the
   * excerpt shows where the body matched, between \u0001 and \u0002, when the title didn't.
   */
  async searchDocuments(args: { query: string, locale?: string, limit?: number }) {
    const locale = this.locale(args.locale);
    if(!this.scope.trusted && !this.scope.session) throw new HttpError(401, "Sign in required");
    const types = Object.keys(this.config.schemas).filter(type => (this.scope.trusted && !this.scope.session) || can(this.state, this.scope.session, { action: "read", type }));
    if(!types.length || !searchWords(args.query).length) return { results: [] };
    const rows = await all<{ id: string, type: string, title: string | null, excerpt: string | null }>(this.db,
      `SELECT id, type, title, ${SNIPPET} AS excerpt FROM vibe_search
        WHERE vibe_search MATCH ? AND locale = ? AND type IN (${types.map(() => "?").join(", ")})
        ORDER BY bm25(vibe_search, 0, 0, 0, 10, 1) LIMIT ?`,
      [ftsQuery(args.query), locale, ...types, Math.min(Math.max(args.limit ?? 20, 1), 50)]);
    return {
      results: rows.map(row => ({ id: row.id, type: row.type, title: row.title, excerpt: bodyExcerpt(row, args.query) }))
    };
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
      const other = (await this.orm.select({ type: documents.type }).from(documents).where(eq(documents.id, id)).limit(1))[0];
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
    const updatedBy = session?.sub ?? null;
    await this.orm.insert(documents)
      .values({ id, type: input.type, locale, draft, schema_hash: this.state.schemaHash, created_at: now, updated_at: now, updated_by: updatedBy })
      .onConflictDoUpdate({
        target: [documents.id, documents.locale],
        set: { draft, schema_hash: this.state.schemaHash, updated_at: now, updated_by: updatedBy }
      });
    this.afterWrite({ type: input.type, id, locale, action, valid: issues.length === 0, doc });
    if(input.publish) return this.publish(input.type, id, locale);
    return { ...(await this.getDocument(input.type, id, locale)), issues };
  }

  /**
   * Gate for plugin actions, whose handlers don't pass through the engine's own checks: needs a session,
   * refuses non-`readOnly` actions to read-only connections, and applies the action's `permit`.
   */
  authorize(action: { readOnly?: boolean }, permit?: Permit): Session {
    const session = this.scope.session;
    if(!session) throw new HttpError(401, "Sign in required");
    if(session.readOnly && !action.readOnly) throw new HttpError(403, "This connection is read only");
    return permit ? require(this.state, session, permit) : session;
  }

  private writer(permit: Parameters<typeof require>[2]): Session | null {
    if(this.scope.trusted && !this.scope.session) return null;
    return require(this.state, this.scope.session, permit);
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
      // The path is a literal, so it matches the field's expression index.
      const taken = (await this.orm.select({ id: documents.id }).from(documents).where(and(
        eq(documents.type, type),
        eq(documents.locale, locale),
        ne(documents.id, id),
        or(
          sql`json_extract(${documents.draft}, ${sql.raw(path)}) = ${value}`,
          sql`json_extract(${documents.published}, ${sql.raw(path)}) = ${value}`
        )
      )).limit(1))[0];
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
      const rows = await this.orm.selectDistinct({ id: documents.id, type: documents.type }).from(documents).where(inArray(documents.id, chunk));
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
      const found = await this.assetsByIds(chunk);
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
    await this.orm.update(documents)
      .set({ draft: data, published: data, published_ver: ver, published_at: now, updated_at: now, updated_by: session?.sub ?? null })
      .where(and(eq(documents.id, id), eq(documents.locale, locale)));
    await this.orm.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.locale, locale), eq(schedules.action, "publish")));
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
    await this.orm.update(documents).set({ published: null, published_ver: null, published_at: null })
      .where(and(eq(documents.id, id), eq(documents.locale, locale)));
    await this.orm.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.locale, locale), eq(schedules.action, "unpublish")));
    this.afterWrite({ type, id, locale, action: "unpublish", valid: false, doc: null });
    return this.getDocument(type, id, locale);
  }

  /** Documents whose draft or published copy mentions this ID. */
  async incomingReferences(id: string) {
    const pattern = `%"${id}"%`;
    return this.orm.select({ id: documents.id, type: documents.type, locale: documents.locale }).from(documents)
      .where(and(ne(documents.id, id), or(like(documents.draft, pattern), like(documents.published, pattern))))
      .limit(20);
  }

  /** Moves the document (or one translation) to the trash. Its history stays until the trash is purged. */
  async delete(type: string, id: string, options: { force?: boolean, locale?: string } = {}) {
    const session = this.writer({ action: "delete", type });
    const exists = (await this.orm.select({ id: documents.id }).from(documents).where(and(eq(documents.id, id), eq(documents.type, type))).limit(1))[0];
    if(!exists) throw new HttpError(404, "Document not found");
    if(options.locale && options.locale !== this.defaultLocale) {
      // Removing one translation only.
      const locale = this.locale(options.locale);
      const rows = await this.orm.select().from(documents).where(and(eq(documents.id, id), eq(documents.locale, locale)));
      if(!rows.length) throw new HttpError(404, "Translation not found");
      const trash = this.trashStatement({ kind: "document", type, itemId: id, locale, label: this.documentLabel(type, rows), payload: rows, session });
      await this.batch([
        trash.statement,
        this.orm.delete(documents).where(and(eq(documents.id, id), eq(documents.locale, locale))),
        this.orm.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.locale, locale)))
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
    const rows = await this.orm.select().from(documents).where(eq(documents.id, id));
    const trash = this.trashStatement({ kind: "document", type, itemId: id, locale: null, label: this.documentLabel(type, rows), payload: rows, session });
    // Pending schedules are dropped: a restored document shouldn't publish itself on an old timetable.
    await this.batch([
      trash.statement,
      this.orm.delete(documents).where(eq(documents.id, id)),
      this.orm.delete(schedules).where(eq(schedules.id, id))
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
    require(this.state, this.scope.session, { action: "read", type });
    const rows = await this.orm
      .select({ ver: versions.ver, author: versions.author, created_at: versions.created_at })
      .from(versions)
      .where(and(eq(versions.id, id), eq(versions.locale, locale)))
      .orderBy(desc(versions.ver))
      .limit(200);
    return rows.map(r => ({ ver: r.ver, author: r.author, createdAt: iso(r.created_at) }));
  }

  async version(type: string, id: string, localeInput: string | undefined, ver: number) {
    const locale = this.locale(localeInput);
    require(this.state, this.scope.session, { action: "read", type });
    const row: VersionRow | undefined = (await this.orm.select().from(versions).where(and(eq(versions.id, id), eq(versions.locale, locale), eq(versions.ver, ver))).limit(1))[0];
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
    const createdBy = session?.sub ?? "system";
    await this.orm.insert(schedules)
      .values({ id, locale, ver, action, run_at: at, created_by: createdBy })
      .onConflictDoUpdate({ target: [schedules.id, schedules.locale, schedules.action], set: { ver, run_at: at, created_by: createdBy } });
    return this.getDocument(type, id, locale);
  }

  async cancelSchedule(type: string, id: string, localeInput: string | undefined, action: "publish" | "unpublish") {
    const locale = this.locale(localeInput);
    this.writer({ action: "publish", type, locale });
    await this.orm.delete(schedules).where(and(eq(schedules.id, id), eq(schedules.locale, locale), eq(schedules.action, action)));
    return this.getDocument(type, id, locale);
  }

  /** Called from the `scheduled` handler. */
  async runSchedules(now = Date.now()): Promise<number> {
    const due: Array<ScheduleRow & { type: string }> = await this.orm
      .select({
        id: schedules.id,
        locale: schedules.locale,
        ver: schedules.ver,
        action: schedules.action,
        run_at: schedules.run_at,
        created_by: schedules.created_by,
        type: documents.type
      })
      .from(schedules)
      .innerJoin(documents, and(eq(documents.id, schedules.id), eq(documents.locale, schedules.locale)))
      .where(lte(schedules.run_at, now))
      .orderBy(schedules.run_at)
      .limit(50);
    for(const item of due) {
      if(item.action === "publish" && item.ver !== null) {
        await this.batch([
          this.orm.update(documents).set({
            published: sql`(SELECT ${versions.data} FROM ${versions} WHERE ${versions.id} = ${item.id} AND ${versions.locale} = ${item.locale} AND ${versions.ver} = ${item.ver})`,
            published_ver: item.ver,
            published_at: now
          }).where(and(eq(documents.id, item.id), eq(documents.locale, item.locale))),
          this.orm.delete(schedules).where(and(eq(schedules.id, item.id), eq(schedules.locale, item.locale), eq(schedules.action, "publish")))
        ]);
        const row = await this.getRow(item.id, item.locale);
        this.afterWrite({ type: item.type, id: item.id, locale: item.locale, action: "publish", valid: Boolean(row?.published), doc: row?.published ? JSON.parse(row.published) as DocumentData : null });
      } else if(item.action === "unpublish") {
        await this.batch([
          this.orm.update(documents).set({ published: null, published_ver: null, published_at: null })
            .where(and(eq(documents.id, item.id), eq(documents.locale, item.locale))),
          this.orm.delete(schedules).where(and(eq(schedules.id, item.id), eq(schedules.locale, item.locale), eq(schedules.action, "unpublish")))
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

  async upload(file: File, options: { folder?: string | null, type?: string, field?: string, stripMetadata?: boolean }) {
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
    let metadataRemoved = false;
    if(hasMetadataSupport(mime) && (options.stripMetadata ?? (await this.storedSite()).stripMetadata ?? true)) {
      const stripped = stripMetadata(new Uint8Array(await file.arrayBuffer()), mime);
      if(stripped) {
        file = new File([stripped], file.name, { type: file.type });
        metadataRemoved = true;
      }
    }
    const head = new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer());
    const meta: AssetMeta = mime.startsWith("image/") ? analyzeImage(head, mime) : {};
    if(metadataRemoved) meta.metadataRemoved = true;
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
    await this.orm.insert(assets).values(row);
    await this.touchFolder(row.folder);
    return this.toAsset(row);
  }

  async listAssets(options: { folder?: string, search?: string, accept?: string[], limit?: number, offset?: number }) {
    require(this.state, this.scope.session, { action: "read", scope: "media" });
    const conditions: SQL[] = [];
    if(options.folder !== undefined) conditions.push(options.folder === "" ? isNull(assets.folder) : eq(assets.folder, options.folder));
    if(options.search) conditions.push(like(assets.filename, `%${options.search}%`));
    const accept = mimeCondition(options.accept);
    if(accept) conditions.push(accept);
    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await this.orm.select().from(assets).where(where)
      .orderBy(desc(assets.created_at))
      .limit(Math.min(options.limit ?? 60, 200))
      .offset(options.offset ?? 0);
    const total = (await this.orm.select({ n: count() }).from(assets).where(where))[0];
    const folderList = await this.listFolders();
    return { assets: rows.map(r => this.toAsset(r)), total: total?.n ?? 0, folders: folderList.map(f => f.path) };
  }

  // --- Folders ---------------------------------------------------------------

  private async touchFolder(path: string | null) {
    if(path) await this.orm.insert(folders).values({ path, created_at: Date.now() }).onConflictDoNothing();
  }

  /** Every folder: stored ones, ones files are in, and all their parents. `accept` counts only files of those types. */
  async listFolders(options: { accept?: string[] } = {}): Promise<MediaFolder[]> {
    require(this.state, this.scope.session, { action: "read", scope: "media" });
    const types = mimeCondition(options.accept);
    const [stored, counts, holding] = await Promise.all([
      this.orm.select({ path: folders.path }).from(folders),
      this.orm.select({ folder: assets.folder, n: count() }).from(assets).where(types ? and(isNotNull(assets.folder), types) : isNotNull(assets.folder)).groupBy(assets.folder),
      // Folders with files of other types still exist, with a count of 0.
      types ? this.orm.selectDistinct({ folder: assets.folder }).from(assets).where(isNotNull(assets.folder)) : Promise.resolve([])
    ]);
    const files = new Map(counts.map(c => [c.folder!, c.n]));
    const paths = new Set<string>();
    for(const path of [...stored.map(s => s.path), ...files.keys(), ...holding.map(h => h.folder!)]) withAncestors(path).forEach(p => paths.add(p));
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
    await this.orm.update(assets)
      .set({ folder: sql`${to} || substr(${assets.folder}, ${from.length + 1})` })
      .where(or(eq(assets.folder, from), sql`substr(${assets.folder}, 1, ${prefix.length}) = ${prefix}`));
    await this.orm.update(folders)
      .set({ path: sql`${to} || substr(${folders.path}, ${from.length + 1})` })
      .where(or(eq(folders.path, from), sql`substr(${folders.path}, 1, ${prefix.length}) = ${prefix}`));
    await this.touchFolder(to);
    return { path: to };
  }

  /** Only empty folders: files have to be moved or deleted first, so nothing disappears by surprise. */
  async deleteFolder(input: string): Promise<{ deleted: true }> {
    this.writer({ action: "delete", scope: "media" });
    const path = normalizeFolder(input);
    if(!path) throw new HttpError(400, "Name the folder");
    const prefix = `${path}/`;
    const used = (await this.orm.select({ id: assets.id }).from(assets)
      .where(or(eq(assets.folder, path), sql`substr(${assets.folder}, 1, ${prefix.length}) = ${prefix}`)).limit(1))[0];
    if(used) throw new HttpError(409, "This folder still has files in it");
    await this.orm.delete(folders).where(or(eq(folders.path, path), sql`substr(${folders.path}, 1, ${prefix.length}) = ${prefix}`));
    return { deleted: true };
  }

  async getAsset(id: string) {
    require(this.state, this.scope.session, { action: "read", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    const pattern = `%"${id}"%`;
    const usage = await this.orm.select({ id: documents.id, type: documents.type, locale: documents.locale }).from(documents)
      .where(or(like(documents.draft, pattern), like(documents.published, pattern))).limit(50);
    return { ...this.toAsset(row), usage };
  }

  /**
   * A file's content, as a `File` named and typed like the asset. For plugin actions and hooks that
   * process an uploaded file. It reads the whole file into memory, so `maxBytes` (10 MB unless you raise it)
   * refuses bigger ones: `streamAsset` is for large files. Needs read access to media.
   */
  async readAsset(id: string, options: { maxBytes?: number } = {}): Promise<File> {
    require(this.state, this.scope.session, { action: "read", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    const maxBytes = options.maxBytes ?? READ_ASSET_MAX_BYTES;
    if(row.size > maxBytes) throw new HttpError(413, `The file is ${row.size} bytes; reading is limited to ${maxBytes}`);
    const object = await this.storage.get(row.key);
    if(!object) throw new HttpError(404, "The file's content is gone");
    return new File([await new Response(object.body).arrayBuffer()], row.filename, { type: row.mime });
  }

  /**
   * A file's content as a stream, for files too large to hold in memory (a Worker has little of it): read
   * it in chunks, or pipe it on. Needs read access to media. `readAsset` is the simpler way for small files.
   */
  async streamAsset(id: string): Promise<{ stream: ReadableStream<Uint8Array>, name: string, type: string, size: number }> {
    require(this.state, this.scope.session, { action: "read", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    const object = await this.storage.get(row.key);
    if(!object) throw new HttpError(404, "The file's content is gone");
    return { stream: object.body as ReadableStream<Uint8Array>, name: row.filename, type: row.mime, size: row.size };
  }

  async updateAsset(id: string, patch: { folder?: string | null, filename?: string }) {
    this.writer({ action: "write", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    const folder = patch.folder === undefined ? row.folder : normalizeFolder(patch.folder);
    const filename = patch.filename?.trim().replace(/[/\\]/g, "_").slice(0, 200) || row.filename;
    await this.touchFolder(folder);
    await this.orm.update(assets).set({ folder, filename }).where(eq(assets.id, id));
    return this.toAsset({ ...row, folder, filename });
  }

  /** Replaces a text file's content in place; the asset keeps its ID, so documents still point at it. */
  async replaceContent(id: string, content: ArrayBuffer) {
    this.writer({ action: "write", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    if(!textKind(row.filename, row.mime)) throw new HttpError(415, "Only text files can be edited");
    if(content.byteLength > MAX_TEXT_EDIT_BYTES) throw new HttpError(413, "Text files can be edited up to 1 MB");
    await this.storage.put(row.key, content, { httpMetadata: { contentType: row.mime } });
    const meta = JSON.parse(row.meta) as AssetMeta;
    const next = JSON.stringify({ ...meta, version: (typeof meta.version === "number" ? meta.version : 0) + 1, editedAt: new Date().toISOString() });
    await this.orm.update(assets).set({ size: content.byteLength, meta: next }).where(eq(assets.id, id));
    return this.toAsset({ ...row, size: content.byteLength, meta: next });
  }

  /**
   * Removes an uploaded photo's location and camera details in place, keeping orientation. The asset
   * keeps its ID; its URL gets a new `?v=`, since media is cached as immutable.
   */
  async stripAssetMetadata(id: string) {
    this.writer({ action: "write", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    if(!hasMetadataSupport(row.mime)) throw new HttpError(415, "Only JPEG, PNG and WebP images can have their details removed");
    const object = await this.storage.get(row.key);
    if(!object) throw new HttpError(404, "The file's content is gone");
    const stripped = stripMetadata(new Uint8Array(await new Response(object.body).arrayBuffer()), row.mime);
    const meta = JSON.parse(row.meta) as AssetMeta;
    if(!stripped) {
      // Nothing to remove: record that, so the editor stops offering.
      if(meta.metadataRemoved) return this.toAsset(row);
      const next = JSON.stringify({ ...meta, metadataRemoved: true });
      await this.orm.update(assets).set({ meta: next }).where(eq(assets.id, id));
      return this.toAsset({ ...row, meta: next });
    }
    await this.storage.put(row.key, stripped, { httpMetadata: { contentType: row.mime } });
    const next = JSON.stringify({ ...meta, metadataRemoved: true, version: (typeof meta.version === "number" ? meta.version : 0) + 1, editedAt: new Date().toISOString() });
    await this.orm.update(assets).set({ size: stripped.byteLength, meta: next }).where(eq(assets.id, id));
    return this.toAsset({ ...row, size: stripped.byteLength, meta: next });
  }

  async deleteAsset(id: string) {
    const session = this.writer({ action: "delete", scope: "media" });
    const row = await this.assetRow(id);
    if(!row) throw new HttpError(404, "Asset not found");
    const pattern = `%"${id}"%`;
    const used = (await this.orm.select({ id: documents.id }).from(documents)
      .where(or(like(documents.draft, pattern), like(documents.published, pattern))).limit(1))[0];
    if(used) throw new HttpError(409, "This file is used by a document");
    if((await this.storedSite()).icon === id) throw new HttpError(409, "This file is the site's icon");
    // The R2 object stays until the trash is purged, so restoring brings back the same URL.
    const trash = this.trashStatement({ kind: "asset", type: null, itemId: id, locale: null, label: row.filename, payload: row, session });
    await this.batch([trash.statement, this.orm.delete(assets).where(eq(assets.id, id))]);
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
    const statement = this.orm.insert(trash).values({
      id,
      kind: input.kind,
      type: input.type,
      item_id: input.itemId,
      locale: input.locale,
      label: input.label,
      payload: JSON.stringify(input.payload),
      deleted_at: Date.now(),
      deleted_by: input.session?.sub ?? "system"
    });
    return { id, statement };
  }

  /** Whether the session may see, restore and purge this item: the same permission that deleted it. */
  private canTrash(row: Pick<TrashRow, "kind" | "type">): boolean {
    if(this.scope.trusted && !this.scope.session) return true;
    return can(this.state, this.scope.session, row.kind === "asset" ? { action: "delete", scope: "media" } : { action: "delete", type: row.type ?? undefined });
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
    const rows = await this.orm.select().from(trash).orderBy(desc(trash.deleted_at)).limit(500);
    const known = (row: TrashRow) => row.kind === "asset" || (row.type !== null && row.type in this.config.schemas);
    return { items: rows.filter(row => known(row) && this.canTrash(row)).map(row => this.toTrashItem(row)), days: this.trashDays };
  }

  private async trashRow(id: string): Promise<TrashRow> {
    if(!this.scope.trusted && !this.scope.session) throw new HttpError(401, "Sign in required");
    const row: TrashRow | undefined = (await this.orm.select().from(trash).where(eq(trash.id, id)).limit(1))[0];
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
      if(await this.assetRow(asset.id)) throw new HttpError(409, "That file already exists");
      await this.batch([
        this.orm.insert(assets).values(asset),
        this.orm.delete(trash).where(eq(trash.id, id))
      ]);
      await this.touchFolder(asset.folder);
      return { ...this.toTrashItem(row), restored: true };
    }
    const type = row.type!;
    getSchema(this.config, type);
    const docs = JSON.parse(row.payload) as DocumentRow[];
    if(row.locale && !(await this.orm.select({ id: documents.id }).from(documents).where(eq(documents.id, row.item_id)).limit(1))[0]) {
      throw new HttpError(409, "Restore the document itself first; this is only one of its translations");
    }
    const taken = await this.orm.select({ locale: documents.locale }).from(documents).where(eq(documents.id, row.item_id));
    if(taken.some(t => docs.some(d => d.locale === t.locale))) throw new HttpError(409, "A document with this ID and language exists again");
    // Files it used that were deleted since come back with it, so its references still resolve.
    const files = await this.orm.select().from(trash).where(eq(trash.kind, "asset"));
    const used = files.filter(file => docs.some(d => d.draft.includes(`"${file.item_id}"`) || d.published?.includes(`"${file.item_id}"`)));
    await this.batch([
      ...docs.map(d => this.orm.insert(documents).values({
        id: d.id,
        type: d.type,
        locale: d.locale,
        draft: d.draft,
        published: d.published,
        published_ver: d.published_ver,
        schema_hash: d.schema_hash,
        created_at: d.created_at,
        updated_at: d.updated_at,
        published_at: d.published_at,
        updated_by: d.updated_by
      })),
      this.orm.delete(trash).where(eq(trash.id, id))
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
      ? await this.orm.select().from(trash)
      : await this.orm.select().from(trash).where(sql`${trash.deleted_at} < ${options.olderThan}`).limit(200);
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
      const live = await this.assetRow(asset.id)
        ?? (await this.orm.select({ id: trash.id }).from(trash).where(and(eq(trash.item_id, asset.id), ne(trash.id, row.id))).limit(1))[0];
      if(!live && this.state.storage) await this.state.storage.delete(asset.key);
      await this.orm.delete(trash).where(eq(trash.id, row.id));
      return;
    }
    const docs = JSON.parse(row.payload) as DocumentRow[];
    const statements: Array<BatchItem<"sqlite">> = [this.orm.delete(trash).where(eq(trash.id, row.id))];
    for(const { locale } of docs) {
      // History goes only when nothing else still needs it: no live row and no other trash entry for that language.
      statements.push(this.orm.delete(versions).where(and(
        eq(versions.id, row.item_id),
        eq(versions.locale, locale),
        notExists(this.orm.select({ one: sql`1` }).from(documents).where(and(eq(documents.id, row.item_id), eq(documents.locale, locale)))),
        notExists(this.orm.select({ one: sql`1` }).from(trash).where(and(
          eq(trash.item_id, row.item_id),
          ne(trash.id, row.id),
          like(trash.payload, `%"locale":"${locale}"%`)
        )))
      )));
    }
    await this.batch(statements);
  }

  // --- Site settings ------------------------------------------------------------

  private async storedSite(): Promise<StoredSite> {
    const raw = await getMeta(this.db, SITE_KEY);
    if(!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed as StoredSite : {};
  }

  private async detectedSite(): Promise<DetectedSite | null> {
    const raw = await getMeta(this.db, DETECTED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return isRecord(parsed) ? parsed as unknown as DetectedSite : null;
  }

  /**
   * Looks at the site from a request's origin: its host and favicon. The first look waits; later
   * ones refresh in the background once a day. In-process callers (no origin) only read what's stored,
   * which also keeps the site's own pages from triggering a look while they render.
   */
  private async detect(): Promise<DetectedSite | null> {
    const stored = await this.detectedSite();
    const { origin } = this.scope;
    const { siteFetch } = this.state;
    if(!origin || !siteFetch) return stored;
    const host = new URL(origin).hostname;
    if(stored && stored.host === host && Date.now() - stored.checked < (stored.favicon ? DETECT_EVERY : DETECT_NONE_EVERY)) return stored;
    let pending = detecting.get(this.db);
    if(!pending) {
      pending = detectFavicon(origin, siteFetch).then(async favicon => {
        const next: DetectedSite = { host, favicon, checked: Date.now() };
        await this.putMeta(DETECTED_KEY, JSON.stringify(next));
        return next;
      }).catch(() => stored).finally(() => detecting.delete(this.db));
      detecting.set(this.db, pending);
    }
    if(!stored) return pending;
    this.scope.ctx?.waitUntil(pending);
    return stored;
  }

  /** Public: the panel shows sites by these before anyone signs in. */
  async site(): Promise<SiteSettings> {
    const [stored, detected] = await Promise.all([this.storedSite(), this.detect()]);
    const row = stored.icon ? await this.assetRow(stored.icon) : null;
    const favicon = detected?.favicon ?? null;
    return {
      id: this.state.siteId,
      name: stored.name ?? detected?.host ?? (this.scope.origin ? new URL(this.scope.origin).hostname : "Untitled site"),
      accent: stored.accent ?? null,
      icon: row ? { id: row.id, url: this.assetUrl(row) } : null,
      favicon: favicon?.startsWith("/") ? `${this.scope.origin}${favicon}` : favicon,
      stripMetadata: stored.stripMetadata ?? true
    };
  }

  async updateSite(patch: SiteSettingsPatch): Promise<SiteSettings> {
    if(!this.scope.trusted || this.scope.session) require(this.state, this.scope.session, { action: "write", scope: "site" });
    const next = await this.storedSite();
    if(patch.name !== undefined) {
      const name = patch.name.trim();
      if(!name || name.length > 80) throw new HttpError(400, "The name needs 1-80 characters");
      next.name = name;
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
        const row = await this.assetRow(patch.icon);
        if(!row) throw new HttpError(400, "Icon asset not found");
        if(!row.mime.startsWith("image/")) throw new HttpError(400, "The icon has to be an image");
        next.icon = row.id;
      }
    }
    if(patch.stripMetadata !== undefined) {
      if(patch.stripMetadata) delete next.stripMetadata;
      else next.stripMetadata = false;
    }
    await this.putMeta(SITE_KEY, JSON.stringify(next));
    return this.site();
  }

  async serveAsset(file: string, request: Request): Promise<Response> {
    const id = file.replace(/\.[a-z0-9]+$/i, "");
    // Trashed files keep their bytes in R2 but aren't served.
    const row = await this.assetRow(id);
    if(!row) return new Response("Not found", { status: 404 });
    if(this.state.imageHealth) {
      const transformed = await serveTransformed({
        request,
        storage: this.storage,
        key: `assets/${id}`,
        mime: row.mime,
        meta: JSON.parse(row.meta) as AssetMeta,
        images: this.state.images,
        health: this.state.imageHealth,
        ctx: this.scope.ctx
      });
      if(transformed) return transformed;
    }
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
    return can(this.state, this.scope.session, permit);
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
/**
 * Published reads fail with the documents and fields whose stored values no longer fit the schema,
 * rather than returning values of the wrong type (or failing deep inside D1).
 */
function checkStoredShape(type: string, schema: ObjectSchema, docs: Doc[]) {
  const found = docs.flatMap(doc => shapeMismatches(schema, doc).map(m => ({ type, id: doc.id, locale: doc.$meta.locale, ...m })));
  if(found.length === 0) return;
  const [first] = found;
  const field = first!.path.join(".");
  const more = found.length > 1 ? ` (and ${found.length - 1} more; see details)` : "";
  throw new HttpError(
    409,
    `Stored content doesn't match the schema: ${type} ${first!.id} (${first!.locale}) has ${first!.found} in "${field}", which expects ${first!.expected}${more}. `
    + "The field's type probably changed after this was published. Fix the document in the editor, or move the data to a new field: `vibe-cms docs schema-changes`.",
    { mismatches: found.slice(0, 20) }
  );
}

export function mapAssets(schema: AnySchema, value: unknown, fn: (value: unknown) => unknown): unknown {
  if(value === undefined || value === null) return value;
  switch(schema.type) {
    case "optional":
      return mapAssets((schema as OptionalSchema).inner, value, fn);
    case "asset": {
      if(!isAssetValue(value)) return value;
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
