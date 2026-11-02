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
import type { StandardProps } from "./schema/standard.ts";

/** What a role may do with a content type or the media library. Any of them also allows `read`. */
export type Action = "read" | "write" | "publish" | "delete";

/**
 * One role's rules, in `permissions.roles`. A user may do anything any of their roles allows.
 * See `vibe-cms docs permissions`.
 */
export interface RoleRules {
  /** Everything, everywhere. */
  all?: boolean,
  /** Whether this role may publish and schedule. Defaults to having `write`. */
  publish?: boolean,
  /** Write (translate) every readable type, only in these locales. Also limits the role's other writes to them. */
  write?: { locales: string[] },
  /** Media library access. Without it: read, upload if the role writes any type, never delete. */
  media?: Action[],
  /** Editing the site's name, accent color and icon. */
  siteSettings?: boolean,
  /** Per content type, or `"*"` for every type without its own rule (a type's rule replaces `"*"`). `delete` is never implied. */
  [type: string]: Action[] | boolean | { locales: string[] } | undefined
}

/** Who may do what on a deployed site. Development sessions have every permission. */
export interface Permissions {
  /** Role name → rules. Only roles defined here count, whatever the identity provider sends. */
  roles?: Record<string, RoleRules>,
  /** Roles per user, keyed by verified email (lowercase) or `<issuer>|<sub>`, on top of the `auth.roles` claim. */
  users?: Record<string, string[]>
}

type TextKeys<S> = S extends ObjectSchema<infer Sh>
  ? { [K in keyof Sh & string]: Unwrap<Sh[K]> extends TextSchema ? K : never }[keyof Sh & string]
  : string;

/** How a content type appears in the editor. Nothing here changes what's stored. See `vibe-cms docs config`. */
export interface CollectionSettings<S = ObjectSchema<any>> {
  /** Text field used as the document title in lists. Defaults to the first text field. */
  title?: TextKeys<S>,
  /** Shown in the editor navigation. Defaults to the content type's name. */
  label?: string,
  /** Only one document of this type, e.g. homepage content. The editor opens it directly; read it with `findFirst()`. */
  singleton?: boolean,
  /** Icon in the editor navigation. */
  icon?: IconName,
  /**
   * The document's URL on the site, for the editor's "View on site" button.
   * `{field}` placeholders are filled from the document; `{id}` and `{locale}` also work.
   */
  preview?: string
}

/** What `defineConfig` takes. See `vibe-cms docs config`. */
export interface ConfigInput {
  /** Stable site ID published in `/.well-known/vibe-cms`. Defaults to the host name. */
  id?: string,
  /**
   * The site's default name, in the editor, the panel and `vibe.site(env)`. A name saved on the
   * editor's Site page overrides it; saving this name there again clears the override.
   */
  name?: string,
  /** Content types: name → `v.object({…})`. `config.schemas.<name>` is then the collection you query. */
  schemas: Record<string, ObjectSchema<any>>,
  /** Editor settings per content type. */
  collections?: Record<string, CollectionSettings<any>>,
  /** Plugin descriptors, e.g. `[SearchPlugin({ … })]`. See `vibe-cms docs plugins`. */
  plugins?: ReadonlyArray<PluginDescriptor<any, any, any>>,
  /** Locales documents can be translated into. Defaults to `[defaultLocale]`. See `vibe-cms docs localization`. */
  locales?: readonly string[],
  /** The locale reads fall back to. Defaults to the first of `locales`, else `"en"`. */
  defaultLocale?: string,
  /** How editors sign in once deployed: `oidc({ issuer, clientId })` from `vibe-cms/auth`. */
  auth?: AuthDescriptor,
  /** Roles and users. See `vibe-cms docs permissions`. */
  permissions?: Permissions,
  /** URL prefix for everything the CMS serves. Defaults to `/_vibe`. */
  prefix?: string,
  /** Deleted documents and files stay restorable this long, then the cron trigger purges them. Defaults to 30 days. */
  trash?: { days?: number }
}

/** A column's path into the document and its field type. */
export interface ColumnInfo {
  path: string[],
  type: string
}

/** A field of a collection, for `where` and `orderBy`: `config.schemas.post.slug`. */
export interface Column<T = unknown> {
  readonly "~column": ColumnInfo,
  readonly "~type"?: T
}

/** What makes a value a collection: its name and schema, and Standard Schema for its stored shape. */
export interface CollectionMarker<N extends string = string, S extends ObjectSchema<any> = ObjectSchema<any>> {
  readonly "~collection": { name: N, schema: S },
  /** The content type's stored shape as Standard Schema and Standard JSON Schema. */
  readonly "~standard": StandardProps<Input<S>>
}

type Unwrap<S> = S extends OptionalSchema<infer I> ? I : S;

type ColumnFor<S> = Column<Input<Unwrap<S>>> & (Unwrap<S> extends ObjectSchema<infer Sh> ? Columns<Sh> : {});

/** A column per field, nested for objects. */
export type Columns<Sh extends Shape> = { readonly [K in keyof Sh]: ColumnFor<Sh[K]> };

/** A content type as it appears on `config.schemas`: pass it to `cms.query()`, and use its fields as columns. */
export type Collection<N extends string = string, S extends ObjectSchema<any> = ObjectSchema<any>> =
  CollectionMarker<N, S> & Columns<S["shape"]> & { readonly id: Column<string> };

/** `config.schemas`: a collection per content type. */
export type Collections<C extends ConfigInput> = {
  readonly [K in keyof C["schemas"] & string]: Collection<K, C["schemas"][K]>
};

/** What `defineConfig` returns: the input with `schemas` turned into collections. Pass `typeof config` to typed APIs. */
export type Config<C extends ConfigInput = ConfigInput> = Omit<C, "schemas"> & {
  readonly schemas: Collections<C>,
  readonly "~config": true
};

/** Any site's config, for code written for every site. */
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
  media?: readonly Action[],
  siteSettings?: boolean
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

/**
 * Defines the site: content types, editor settings, plugins, locales and permissions.
 * The default export of `vibe-cms.config.ts`, imported by the Worker and the editor, so
 * keep it to schemas and descriptors. Strings that name schemas (collection keys, `title`,
 * `preview` placeholders, role rules, `v.ref()` targets, locales) are checked at the type level.
 * See `vibe-cms docs config`.
 */
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
  const standard = schema["~standard"];
  Object.defineProperty(collection, "~standard", {
    value: {
      ...standard,
      jsonSchema: {
        input: options => ({ title: name, ...standard.jsonSchema.input(options) }),
        output: options => ({ title: name, ...standard.jsonSchema.output(options) })
      }
    } satisfies StandardProps,
    enumerable: false
  });
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

/** Whether a value is a collection from `config.schemas`. */
export function isCollection(value: unknown): value is Collection {
  return typeof value === "object" && value !== null && "~collection" in value;
}

/** A collection's content type name and schema. */
export function collectionInfo(collection: CollectionMarker): { name: string, schema: ObjectSchema } {
  return collection["~collection"];
}

/** A column's path and type. Throws for anything that isn't a column. */
export function columnInfo(col: Column): ColumnInfo {
  const info = (col as { "~column"?: ColumnInfo })["~column"];
  if(!info) throw new Error("vibe-cms: expected a field from config.schemas, e.g. `post.slug`");
  return info;
}

/** A content type's schema by name. Throws a 404 `HttpError` for unknown types. */
export function getSchema(config: AnyConfig, type: string): ObjectSchema {
  const collection = (config.schemas as Record<string, Collection | undefined>)[type];
  if(!collection) throw new HttpError(404, `Unknown content type "${type}"`);
  return collection["~collection"].schema;
}

/** The site's content type names. */
export function collectionNames(config: AnyConfig): string[] {
  return Object.keys(config.schemas);
}

/** An error with an HTTP status, thrown inside the engine and turned into a tagged action error at its boundary. */
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

/** The config as JSON, as the editor receives it. */
export interface SerializedConfig {
  id?: string,
  name?: string,
  locales: string[],
  defaultLocale: string,
  collections: Record<string, CollectionSettings>,
  schemas: Record<string, ObjectSchema>,
  plugins: Array<{ name: string }>
}
