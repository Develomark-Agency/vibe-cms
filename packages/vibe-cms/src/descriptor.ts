/**
 * Descriptors are the tagged, serializable objects that make up the config tree.
 * Anything implementation-specific (lazy imports, functions) hangs off the IMPL
 * symbol so `JSON.stringify` drops it.
 */

/** Where descriptors keep their lazy imports, out of `JSON.stringify`'s reach. */
export const IMPL: unique symbol = Symbol.for("vibe-cms.impl") as never;

type Lazy<T> = () => Promise<T | { default: T }>;

/** A widget placed on a field through its `widget` option. Made by a `defineWidget` factory. */
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

/** Makes a widget descriptor from per-field options; the options argument is optional when all options are. */
export type WidgetFactory<T, O> = {} extends O
  ? (options?: O) => WidgetDescriptor<T, O>
  : (options: O) => WidgetDescriptor<T, O>;

/**
 * Declares a field widget: `T` is the value it edits (using it on a field of
 * another type is a type error), `O` its options. The descriptor is plain data,
 * safe for the config; `admin` lazily imports the `*.admin.*` implementation
 * (`defineReactWidget`, or a `WidgetImpl`). See `vibe-cms docs widgets`.
 */
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

/** What a `definePlugin` factory returns. */
export interface PluginDefinition<O> {
  /** Letters, digits, `_` and `-`: used in URLs (`/_vibe/plugins/<name>/`, `/_vibe/admin/p/<name>/`) and as the bindings key. */
  name: string,
  /** Plain data, handed to the server entry. */
  options: O,
  /** `() => import("./plugin.server.ts")`, whose default export is `defineServer(…)`. Loaded only in the Worker. */
  server?: Lazy<unknown>,
  /** `() => import("./plugin.admin.tsx")`, whose default export is `defineAdmin(…)`. Loaded only in the editor. */
  admin?: Lazy<unknown>,
  /** Classes re-exported through `vibe-cms/exports`. */
  exports?: PluginWorkerExports
}

/** A plugin as listed in the config's `plugins`. Made by a `definePlugin` factory. */
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
 * Declares a plugin. Curried so the binding contract (what the site must
 * supply in `createHandler({ bindings })` under the plugin's name) can be given
 * explicitly while the plugin's options and name are inferred. The factory's
 * parameters are the plugin's options. See `vibe-cms docs plugins`.
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

/** Resolves a lazy import, unwrapping a default export. */
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
