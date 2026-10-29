import { collectionInfo, columnInfo, type AnyConfig, type Collection, type CollectionMarker, type Column } from "../config.ts";
import type {
  ArraySchema,
  AssetSchema,
  DocumentData,
  Input,
  ObjectSchema,
  OptionalSchema,
  Output,
  RefSchema,
  Shape
} from "../schema/types.ts";

type Primitive = string | number | boolean | null;

/** Where-clause AST. Plain data, so it can be sent over HTTP as-is. */
export type Condition =
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like" | "has", path: string[], value: Primitive }
  | { op: "in" | "nin", path: string[], values: Primitive[] }
  | { op: "null" | "notNull", path: string[] }
  | { op: "and" | "or", conditions: Condition[] }
  | { op: "not", condition: Condition }
  | { op: "search", value: string };

export interface Order {
  path: string[],
  dir: "asc" | "desc"
}

type ValueOf<C> = C extends Column<infer T> ? (T extends string ? T | Date : T) : never;

function path(col: Column): string[] {
  return columnInfo(col).path;
}

function scalar(value: unknown): Primitive {
  return value instanceof Date ? value.toISOString() : (value as Primitive);
}

export function eq<C extends Column>(col: C, value: ValueOf<C>): Condition {
  return { op: "eq", path: path(col), value: scalar(value) };
}

export function ne<C extends Column>(col: C, value: ValueOf<C>): Condition {
  return { op: "ne", path: path(col), value: scalar(value) };
}

export function gt<C extends Column>(col: C, value: ValueOf<C>): Condition {
  return { op: "gt", path: path(col), value: scalar(value) };
}

export function gte<C extends Column>(col: C, value: ValueOf<C>): Condition {
  return { op: "gte", path: path(col), value: scalar(value) };
}

export function lt<C extends Column>(col: C, value: ValueOf<C>): Condition {
  return { op: "lt", path: path(col), value: scalar(value) };
}

export function lte<C extends Column>(col: C, value: ValueOf<C>): Condition {
  return { op: "lte", path: path(col), value: scalar(value) };
}

/** SQL `LIKE`, case-insensitive for ASCII. Use `%` as the wildcard. */
export function like(col: Column<string | undefined>, pattern: string): Condition {
  return { op: "like", path: path(col), value: pattern };
}

export function inArray<C extends Column>(col: C, values: ReadonlyArray<ValueOf<C>>): Condition {
  return { op: "in", path: path(col), values: values.map(scalar) };
}

export function notInArray<C extends Column>(col: C, values: ReadonlyArray<ValueOf<C>>): Condition {
  return { op: "nin", path: path(col), values: values.map(scalar) };
}

/** Array field contains a value: `has(post.tags, "news")`. */
export function has<T>(col: Column<T[] | undefined>, value: T): Condition {
  return { op: "has", path: path(col), value: scalar(value) };
}

export function isNull(col: Column): Condition {
  return { op: "null", path: path(col) };
}

export function isNotNull(col: Column): Condition {
  return { op: "notNull", path: path(col) };
}

export function and(...conditions: Array<Condition | undefined | false>): Condition {
  return { op: "and", conditions: conditions.filter((c): c is Condition => Boolean(c)) };
}

export function or(...conditions: Array<Condition | undefined | false>): Condition {
  return { op: "or", conditions: conditions.filter((c): c is Condition => Boolean(c)) };
}

export function not(condition: Condition): Condition {
  return { op: "not", condition };
}

/** Loose text match over the whole document. */
export function search(value: string): Condition {
  return { op: "search", value };
}

export function asc(col: Column): Order {
  return { path: path(col), dir: "asc" };
}

export function desc(col: Column): Order {
  return { path: path(col), dir: "desc" };
}

/** Sorts by document metadata rather than a field. */
export const meta = {
  updatedAt: metaColumn("$updatedAt"),
  createdAt: metaColumn("$createdAt"),
  publishedAt: metaColumn("$publishedAt")
};

function metaColumn(name: string): Column<string> {
  const col = {};
  Object.defineProperty(col, "~column", { value: { path: [name], type: "date" }, enumerable: false });
  return col as Column<string>;
}

// --- Requests -------------------------------------------------------------

export interface WithOptions {
  where?: Condition,
  orderBy?: Order[],
  limit?: number,
  with?: Record<string, true | WithOptions>
}

export type WithSpec = Record<string, true | WithOptions>;

export interface FindOptions<W extends WithSpec = WithSpec, L extends string = string> {
  where?: Condition,
  orderBy?: Order[],
  limit?: number,
  offset?: number,
  /** One of the site's `locales`; falls back to the default locale per document. */
  locale?: L,
  with?: W
}

/** The site's locales, from `defineConfig({ locales })`. */
export type LocaleOf<Cfg> = Cfg extends { locales: ReadonlyArray<infer L extends string> } ? L : string;

export interface QueryArgs {
  where?: Condition,
  orderBy?: Order[],
  limit?: number,
  offset?: number,
  locale?: string,
  with?: WithSpec,
  id?: string
}

/** A serializable query. Awaiting it runs it through the client that built it. */
export interface QueryRequest<T = unknown> extends PromiseLike<T> {
  readonly type: string,
  readonly op: "findMany" | "findFirst" | "findById" | "count",
  readonly args: QueryArgs,
  readonly drafts?: boolean,
  readonly "~result"?: T
}

export type SerializedQuery = Pick<QueryRequest, "type" | "op" | "args" | "drafts">;

export type Executor = (queries: SerializedQuery[]) => Promise<unknown[]>;

// A type alias (not an interface) so documents carrying it stay valid JSON objects.
export type DocumentMeta = {
  locale: string,
  createdAt: string,
  updatedAt: string,
  publishedAt: string | null,
  status: "draft" | "published" | "changed"
};

type SchemasOf<Cfg> = Cfg extends { schemas: infer S } ? S : never;

type ShapeOf<C> = C extends CollectionMarker<any, infer S> ? (S extends ObjectSchema<infer Sh> ? Sh : never) : never;

export type Doc<C> = (C extends CollectionMarker<any, infer S> ? Output<S> : never) & {
  id: string,
  $meta: DocumentMeta
};

type Unwrap<S> = S extends OptionalSchema<infer I> ? I : S;
type Optionality<S> = S extends OptionalSchema<any> ? undefined : never;

type TargetDoc<Cfg, To, Spec> = To extends keyof SchemasOf<Cfg>
  ? Result<Cfg, SchemasOf<Cfg>[To], Spec extends { with: infer W } ? W : {}>
  : Doc<CollectionMarker> & DocumentData;

type ExpandField<Cfg, S, Spec> = Unwrap<S> extends RefSchema<infer To>
  ? TargetDoc<Cfg, To, Spec> | null | Optionality<S>
  : Unwrap<S> extends ArraySchema<infer I>
    ? I extends RefSchema<infer To> ? Array<TargetDoc<Cfg, To, Spec>> | Optionality<S> : never
    : never;

type ReverseTarget<Cfg, K> = K extends keyof SchemasOf<Cfg>
  ? K
  : K extends `${infer Base}s` ? Base extends keyof SchemasOf<Cfg> ? Base : never : never;

type Expansions<Cfg, C, W> = {
  [K in keyof W]: K extends keyof ShapeOf<C>
    ? ExpandField<Cfg, ShapeOf<C>[K], W[K]>
    : Array<Result<Cfg, SchemasOf<Cfg>[ReverseTarget<Cfg, K>], W[K] extends { with: infer N } ? N : {}>>
};

export type Result<Cfg, C, W = {}> = {} extends W
  ? Doc<C>
  : Omit<Doc<C>, keyof W> & Expansions<Cfg, C, W>;

/** Keys a `with:` may name: forward refs, or a collection whose refs point back here. */
type RefKeys<Sh> = { [K in keyof Sh]: Unwrap<Sh[K]> extends RefSchema<any> | ArraySchema<RefSchema<any>> ? K : never }[keyof Sh];
export type WithFor<Cfg, C> = { [K in RefKeys<ShapeOf<C>>]?: true | WithOptions } & {
  [K in keyof SchemasOf<Cfg> as `${K & string}s`]?: true | WithOptions
};

export interface QueryBuilder<Cfg, C> {
  findMany<const W extends WithFor<Cfg, C> = {}>(options?: FindOptions<W & WithSpec, LocaleOf<Cfg>>): QueryRequest<Array<Result<Cfg, C, W>>>,
  findFirst<const W extends WithFor<Cfg, C> = {}>(options?: FindOptions<W & WithSpec, LocaleOf<Cfg>>): QueryRequest<Result<Cfg, C, W> | null>,
  findById<const W extends WithFor<Cfg, C> = {}>(id: string, options?: Omit<FindOptions<W & WithSpec, LocaleOf<Cfg>>, "where">): QueryRequest<Result<Cfg, C, W> | null>,
  count(options?: Pick<FindOptions<WithSpec, LocaleOf<Cfg>>, "where" | "locale">): QueryRequest<number>
}

export interface QueryOptions {
  /** Read working copies instead of published content. Requires an authorized client. */
  drafts?: boolean
}

export function createQueryBuilder<Cfg, C extends CollectionMarker>(
  collection: C,
  execute: Executor,
  options: QueryOptions = {}
): QueryBuilder<Cfg, C> {
  const { name } = collectionInfo(collection);
  function request<T>(op: QueryRequest["op"], args: QueryArgs): QueryRequest<T> {
    const query = { type: name, op, args, ...(options.drafts ? { drafts: true } : {}) };
    let promise: Promise<T> | undefined;
    return {
      ...query,
      // Lazy thenable: queries run when awaited, or are batched without running.
      // oxlint-disable-next-line unicorn/no-thenable
      then(resolve, reject) {
        promise ??= execute([query]).then(results => results[0] as T);
        return promise.then(resolve, reject);
      }
    };
  }
  return {
    findMany: opts => request("findMany", opts ?? {}),
    findFirst: opts => request("findFirst", opts ?? {}),
    findById: (id, opts) => request("findById", { ...opts, id }),
    count: opts => request("count", opts ?? {})
  };
}

export interface QueryClient<Cfg> {
  query<C extends Collection>(collection: C, options?: QueryOptions): QueryBuilder<Cfg, C>,
  /** Runs several queries in one round trip. */
  batch<const Q extends readonly QueryRequest[]>(queries: Q): Promise<{ [K in keyof Q]: Awaited<Q[K]> }>
}

export function createQueryClient<Cfg extends AnyConfig>(execute: Executor): QueryClient<Cfg> {
  return {
    query: (collection, options) => createQueryBuilder(collection, execute, options),
    batch: async queries => (await execute(queries.map(serializeQuery))) as never
  };
}

export function serializeQuery(query: QueryRequest | SerializedQuery): SerializedQuery {
  return { type: query.type, op: query.op, args: query.args, ...(query.drafts ? { drafts: true } : {}) };
}

export type { Input, Output, Shape, AssetSchema };
