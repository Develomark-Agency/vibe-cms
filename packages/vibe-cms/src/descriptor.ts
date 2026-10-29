/**
 * Descriptors are the tagged, serializable objects that make up the config tree.
 * Anything implementation-specific (lazy imports, functions) hangs off the IMPL
 * symbol so `JSON.stringify` drops it.
 */

export const IMPL: unique symbol = Symbol.for("vibe-cms.impl") as never;

type Lazy<T> = () => Promise<T | { default: T }>;

export interface WidgetDescriptor<T = any, O = any> {
  kind: "widget",
  id: string,
  options: O,
  [IMPL]: { admin: Lazy<unknown> },
  /** Phantom: makes widgets invariant in the value type they edit. */
  readonly "~value"?: (value: T) => T
}

export interface WidgetDefinition {
  /** Namespaced ID, e.g. `@acme/rich-text:editor`. */
  id: string,
  /** The `.admin` implementation, only ever loaded by the admin bundle. */
  admin: Lazy<unknown>
}

export type WidgetFactory<T, O> = {} extends O
  ? (options?: O) => WidgetDescriptor<T, O>
  : (options: O) => WidgetDescriptor<T, O>;

export function defineWidget<T, O = {}>(definition: WidgetDefinition): WidgetFactory<T, O> {
  function factory(options?: O): WidgetDescriptor<T, O> {
    return {
      kind: "widget",
      id: definition.id,
      options: (options ?? {}) as O,
      [IMPL]: { admin: definition.admin }
    };
  }
  return factory as WidgetFactory<T, O>;
}

export interface PluginWorkerExports {
  /** Module that exports the classes, usually `import.meta.url` of the plugin's entry. */
  from: string,
  /** Durable Object / Workflow class names Cloudflare needs on the Worker entry. */
  names: string[]
}

export interface PluginDefinition<O> {
  name: string,
  options: O,
  server?: Lazy<unknown>,
  admin?: Lazy<unknown>,
  /** Classes re-exported through `vibe-cms/exports`. */
  exports?: PluginWorkerExports
}

export interface PluginDescriptor<B = {}, O = any, N extends string = string> {
  kind: "plugin",
  name: N,
  options: O,
  exports?: PluginWorkerExports,
  [IMPL]: { server?: Lazy<unknown>, admin?: Lazy<unknown> },
  /** Phantom: the binding contract supplied through `createHandler`. */
  readonly "~bindings"?: B
}

/**
 * Curried so the binding contract can be given explicitly while the
 * plugin's options and name are inferred.
 *
 * ```ts
 * export const SearchPlugin = definePlugin<{ cache: KVNamespace }>()((options: SearchOptions = {}) => ({
 *   name: "search",
 *   options,
 *   server: () => import("./plugin.server"),
 * }));
 * ```
 */
export function definePlugin<B = {}>() {
  return function <A extends unknown[], const N extends string, O>(
    define: (...args: A) => PluginDefinition<O> & { name: N }
  ): (...args: A) => PluginDescriptor<B, O, N> {
    return (...args: A) => {
      const { name, options, server, admin, exports } = define(...args);
      return {
        kind: "plugin",
        name,
        options,
        ...(exports ? { exports } : {}),
        [IMPL]: { server, admin }
      };
    };
  };
}

export async function loadLazy<T>(lazy: Lazy<T>): Promise<T> {
  const mod = (await lazy()) as T | { default: T };
  if(mod && typeof mod === "object" && "default" in mod) return mod.default;
  return mod as T;
}

export function isWidget(value: unknown): value is WidgetDescriptor {
  return isTagged(value, "widget");
}

export function isPlugin(value: unknown): value is PluginDescriptor {
  return isTagged(value, "plugin");
}

function isTagged(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === kind;
}

/**
 * Walks the config tree and yields every tagged descriptor. Registration is
 * implicit: using a widget anywhere in the tree is enough.
 */
export function collectDescriptors(root: unknown): { widgets: Map<string, WidgetDescriptor>, plugins: PluginDescriptor[] } {
  const widgets = new Map<string, WidgetDescriptor>();
  const plugins: PluginDescriptor[] = [];
  const seen = new Set<unknown>();
  function visit(value: unknown) {
    if(typeof value !== "object" || value === null || seen.has(value)) return;
    seen.add(value);
    if(isWidget(value)) {
      if(!widgets.has(value.id)) widgets.set(value.id, value);
      return;
    }
    if(isPlugin(value)) plugins.push(value);
    for(const child of Object.values(value)) visit(child);
  }
  visit(root);
  return { widgets, plugins };
}
