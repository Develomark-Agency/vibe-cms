import type { Collection, Column } from "../index.ts";
import type { LocaleOf, QueryClient } from "../query/index.ts";
import { eq } from "../query/index.ts";
import v from "../schema/index.ts";
import type { FieldOptions, LiteralSchema, ObjectSchema, Output, Shape } from "../schema/index.ts";

type Icon = FieldOptions<unknown>["icon"];

/** A block's stored shape: its fields plus `type`, which tells blocks apart in a page. */
export type BlockSchema<T extends string = string, F extends Shape = Shape> = ObjectSchema<{ type: LiteralSchema<T> } & F>;

/**
 * What a block is: its type, how it's labelled in the editor and which inputs
 * it has. How it renders lives with your site's components (see the html,
 * react and astro adapters), so the CMS config never imports UI code.
 */
export interface BlockDefinition<T extends string = string, F extends Shape = Shape> {
  readonly type: T,
  readonly label: string,
  readonly schema: BlockSchema<T, F>
}

export function defineBlock<const T extends string, const F extends Shape>(definition: {
  /** Stored with each block, so keep it stable: `pricing`, `team-grid`. */
  type: T,
  label: string,
  description?: string,
  icon?: Icon,
  fields: F
}): BlockDefinition<T, F> {
  if(!/^[a-z][a-z0-9-]*$/.test(definition.type)) {
    throw new Error(`Block type "${definition.type}" must be lowercase letters, numbers and dashes`);
  }
  if("type" in definition.fields) throw new Error(`Block "${definition.type}" can't have a field called "type"`);
  const schema = v.object(
    { type: v.literal(definition.type, { hidden: true }), ...definition.fields },
    { label: definition.label, description: definition.description, icon: definition.icon }
  ) as BlockSchema<T, F>;
  return { type: definition.type, label: definition.label, schema };
}

/** The data a block receives when rendered: what queries return for it, with assets resolved. */
export type BlockProps<B> = B extends BlockDefinition<any, any> ? Output<B["schema"]> : never;

/** Any rendered block: an object tagged with its `type`. */
export interface AnyBlock {
  type: string
}

type SchemasOf<B extends ReadonlyArray<BlockDefinition<any, any>>> = { [K in keyof B]: B[K] extends BlockDefinition<any, any> ? B[K]["schema"] : never };

/** An ordered list of blocks: editors add, reorder and remove them. Use it for page-like fields of your own. */
export function blocks<const B extends ReadonlyArray<BlockDefinition<any, any>>>(definitions: B, options: { label?: string, description?: string, min?: number, max?: number } = {}) {
  const seen = new Set<string>();
  for(const definition of definitions) {
    if(seen.has(definition.type)) throw new Error(`Two blocks share the type "${definition.type}"`);
    seen.add(definition.type);
  }
  const schemas = definitions.map(definition => definition.schema) as unknown as SchemasOf<B>;
  return v.array(v.union(schemas), { label: options.label ?? "Blocks", description: options.description, min: options.min, max: options.max });
}

/** `"/About/Team/"` → `"/about/team"`. Also how page paths are stored. */
export function normalizePath(pathname: string): string {
  let path = pathname.split(/[?#]/)[0] ?? "";
  try {
    path = decodeURI(path);
  } catch {
    // Malformed escapes: use the path as given.
  }
  path = `/${path}`.replace(/\/{2,}/g, "/").replace(/\/index(\.html?)?$/i, "/").toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, "") : "/";
}

/**
 * The published page at `pathname`, or null. `pages` is your page collection,
 * e.g. `config.schemas.page`; pass `drafts: true` from preview routes.
 */
export async function findPage<Cfg, C extends Collection & { readonly path: Column<string> }>(
  cms: QueryClient<Cfg>,
  pages: C,
  pathname: string,
  options: { locale?: LocaleOf<Cfg>, drafts?: boolean } = {}
) {
  return cms.query(pages, options.drafts ? { drafts: true } : undefined).findFirst({ where: eq(pages.path, normalizePath(pathname)), locale: options.locale });
}
