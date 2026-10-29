import type { PluginDescriptor } from "./descriptor.ts";
import type {
  AnySchema,
  ArraySchema,
  AssetSchema,
  Input,
  ObjectSchema,
  OptionalSchema,
  RefSchema,
  Shape,
  TextSchema,
  UnionSchema
} from "./schema/types.ts";
import type { AuthDescriptor } from "./auth/index.ts";
import type { IconName } from "./icons.ts";

export type Action = "read" | "write" | "publish" | "delete";

export interface RoleRules {
  /** Everything, everywhere. */
  all?: boolean,
  /** Whether this role may publish and schedule. Defaults to having `write`. */
  publish?: boolean,
  /** Restrict writes to these locales. */
  write?: { locales: string[] },
  /** Media library access. */
  media?: Action[],
  /** Per content type, or `"*"` for every type. */
  [type: string]: Action[] | boolean | { locales: string[] } | undefined
}

export interface Permissions {
  roles?: Record<string, RoleRules>,
  /** Keyed by verified email or `<issuer>|<sub>`. */
  users?: Record<string, string[]>
}

type TextKeys<S> = S extends ObjectSchema<infer Sh>
  ? { [K in keyof Sh & string]: Unwrap<Sh[K]> extends TextSchema ? K : never }[keyof Sh & string]
  : string;

export interface CollectionSettings<S = ObjectSchema<any>> {
  /** Text field used as the document title in lists. Defaults to the first text field. */
  title?: TextKeys<S>,
  /** Shown in the editor navigation. */
  label?: string,
  /** Only one document of this type, e.g. site settings. */
  singleton?: boolean,
  /** Icon in the editor navigation. */
  icon?: IconName,
  /**
   * The document's URL on the site, for the editor's "View on site" button.
   * `{field}` placeholders are filled from the document; `{id}` and `{locale}` also work.
   */
  preview?: string
}

export interface ConfigInput {
  /** Stable site ID published in `/.well-known/vibe-cms`. */
  id?: string,
  /** Display name for the panel's site list. */
  name?: string,
  schemas: Record<string, ObjectSchema<any>>,
  collections?: Record<string, CollectionSettings<any>>,
  plugins?: ReadonlyArray<PluginDescriptor<any, any, any>>,
  locales?: readonly string[],
  defaultLocale?: string,
  auth?: AuthDescriptor,
  permissions?: Permissions,
  /** URL prefix for everything the CMS serves. Defaults to `/_vibe`. */
  prefix?: string
}

export interface ColumnInfo {
  path: string[],
  type: string
}

export interface Column<T = unknown> {
  readonly "~column": ColumnInfo,
  readonly "~type"?: T
}

export interface CollectionMarker<N extends string = string, S extends ObjectSchema<any> = ObjectSchema<any>> {
  readonly "~collection": { name: N, schema: S }
}

type Unwrap<S> = S extends OptionalSchema<infer I> ? I : S;

type ColumnFor<S> = Column<Input<Unwrap<S>>> & (Unwrap<S> extends ObjectSchema<infer Sh> ? Columns<Sh> : {});

export type Columns<Sh extends Shape> = { readonly [K in keyof Sh]: ColumnFor<Sh[K]> };

export type Collection<N extends string = string, S extends ObjectSchema<any> = ObjectSchema<any>> =
  CollectionMarker<N, S> & Columns<S["shape"]> & { readonly id: Column<string> };

export type Collections<C extends ConfigInput> = {
  readonly [K in keyof C["schemas"] & string]: Collection<K, C["schemas"][K]>
};

export type Config<C extends ConfigInput = ConfigInput> = Omit<C, "schemas"> & {
  readonly schemas: Collections<C>,
  readonly "~config": true
};

export type AnyConfig = Config<ConfigInput>;

// --- Checks that tie the config's strings to its own schemas ----------------------

type Types<C extends ConfigInput> = keyof C["schemas"] & string;
type Locales<C> = C extends { locales: ReadonlyArray<infer L extends string> } ? L : string;
type RoleNames<C> = C extends { permissions: { roles: infer R } } ? keyof R & string : string;
type Extra<T, Allowed> = { [K in Exclude<keyof T, Allowed>]: never };

/** Every content type a `v.ref("...")` anywhere in a schema points at. */
type RefTargets<S> =
  S extends RefSchema<infer To> ? (To extends string ? To : never)
    : S extends OptionalSchema<infer I> ? RefTargets<I>
      : S extends ArraySchema<infer I> ? RefTargets<I>
        : S extends UnionSchema<infer O> ? RefTargets<O[number]>
          : S extends AssetSchema<infer F> ? { [K in keyof F]: RefTargets<F[K]> }[keyof F]
            : S extends ObjectSchema<infer Sh> ? { [K in keyof Sh]: RefTargets<Sh[K]> }[keyof Sh]
              : never;

type UnknownRefTargets<C extends ConfigInput> = Exclude<{ [K in Types<C>]: RefTargets<C["schemas"][K]> }[Types<C>], Types<C>>;

type RuleChecks<C extends ConfigInput> = {
  all?: boolean,
  publish?: boolean,
  write?: { locales: ReadonlyArray<Locales<C>> },
  media?: readonly Action[]
} & { [T in Types<C> | "*"]?: readonly Action[] };

type Placeholders<T> = T extends `${string}{${infer K}}${infer Rest}` ? K | Placeholders<Rest> : never;
type FieldKeys<S> = S extends ObjectSchema<infer Sh> ? keyof Sh & string : string;

/** `"/posts/{slug}"` stays as is; `"/posts/{slugg}"` becomes an error message naming the unknown field. */
type CheckPreview<T, S> = [Exclude<Placeholders<T>, FieldKeys<S> | "id" | "locale">] extends [never]
  ? T
  : `Unknown field in preview: {${Exclude<Placeholders<T>, FieldKeys<S> | "id" | "locale"> & string}}`;

type CollectionChecks<C extends ConfigInput> = {
  [K in Types<C>]?: CollectionSettings<C["schemas"][K]> & {
    preview?: CheckPreview<NonNullable<NonNullable<C["collections"]>[K]>["preview"], C["schemas"][K]>
  }
};

type ConfigChecks<C extends ConfigInput> = {
  collections?: CollectionChecks<C> & Extra<C["collections"], Types<C>>,
  defaultLocale?: Locales<C>,
  permissions?: {
    roles?: {
      [R in keyof NonNullable<NonNullable<C["permissions"]>["roles"]>]:
        RuleChecks<C> & Extra<NonNullable<NonNullable<C["permissions"]>["roles"]>[R], keyof RuleChecks<C>>
    },
    users?: Record<string, ReadonlyArray<RoleNames<C>>>
  }
} & ([UnknownRefTargets<C>] extends [never] ? {} : {
  "~error": `v.ref("${UnknownRefTargets<C> & string}") points at a content type that isn't in schemas`
});

export function defineConfig<const C extends ConfigInput>(input: C & ConfigChecks<C>): Config<C> {
  const schemas: Record<string, Collection> = {};
  for(const [name, schema] of Object.entries(input.schemas)) {
    if(!/^[a-zA-Z][\w-]*$/.test(name)) throw new Error(`vibe-cms: invalid content type name "${name}"`);
    schemas[name] = createCollection(name, schema);
  }
  const locales = input.locales?.length ? input.locales : [input.defaultLocale ?? "en"];
  return {
    ...input,
    locales,
    defaultLocale: input.defaultLocale ?? locales[0],
    schemas,
    "~config": true
  } as unknown as Config<C>;
}

function createCollection(name: string, schema: ObjectSchema): Collection {
  const collection = {
    ...createColumns(schema.shape, []),
    id: column(["id"], "text")
  } as Record<string, unknown>;
  Object.defineProperty(collection, "~collection", { value: { name, schema }, enumerable: false });
  return collection as unknown as Collection;
}

function createColumns(shape: Shape, path: string[]): Record<string, Column> {
  const out: Record<string, Column> = {};
  for(const [key, field] of Object.entries(shape)) {
    const inner: AnySchema = field.type === "optional" ? (field as OptionalSchema).inner : field;
    const col = column([...path, key], inner.type);
    if(inner.type === "object") Object.assign(col, createColumns((inner as ObjectSchema).shape, [...path, key]));
    out[key] = col;
  }
  return out;
}

function column(path: string[], type: string): Column {
  const col = {};
  Object.defineProperty(col, "~column", { value: { path, type }, enumerable: false });
  return col as Column;
}

export function isCollection(value: unknown): value is Collection {
  return typeof value === "object" && value !== null && "~collection" in value;
}

export function collectionInfo(collection: CollectionMarker): { name: string, schema: ObjectSchema } {
  return collection["~collection"];
}

export function columnInfo(col: Column): ColumnInfo {
  const info = (col as { "~column"?: ColumnInfo })["~column"];
  if(!info) throw new Error("vibe-cms: expected a field from config.schemas, e.g. `post.slug`");
  return info;
}

export function getSchema(config: AnyConfig, type: string): ObjectSchema {
  const collection = (config.schemas as Record<string, Collection | undefined>)[type];
  if(!collection) throw new HttpError(404, `Unknown content type "${type}"`);
  return collection["~collection"].schema;
}

export function collectionNames(config: AnyConfig): string[] {
  return Object.keys(config.schemas);
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

/** The schema tree as plain data: what the admin receives and what gets hashed for `schema_hash`. */
export function serializeConfig(config: AnyConfig) {
  const schemas: Record<string, ObjectSchema> = {};
  for(const [name, collection] of Object.entries(config.schemas as Record<string, Collection>)) {
    schemas[name] = collection["~collection"].schema;
  }
  return JSON.parse(JSON.stringify({
    id: config.id,
    name: config.name,
    locales: config.locales,
    defaultLocale: config.defaultLocale,
    collections: config.collections ?? {},
    schemas,
    plugins: (config.plugins ?? []).map(p => ({ name: p.name }))
  })) as SerializedConfig;
}

export interface SerializedConfig {
  id?: string,
  name?: string,
  locales: string[],
  defaultLocale: string,
  collections: Record<string, CollectionSettings>,
  schemas: Record<string, ObjectSchema>,
  plugins: Array<{ name: string }>
}
