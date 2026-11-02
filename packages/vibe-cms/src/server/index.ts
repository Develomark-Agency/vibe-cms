import type { PluginDescriptor } from "../descriptor.ts";
import type { AnyConfig, CollectionMarker } from "../config.ts";
import type { QueryClient } from "../query/index.ts";
import type { AssetMeta, DocumentData, Input, Output } from "../schema/types.ts";
import type { MessageBatch } from "../handler/platform.ts";

/** What a write did. `restore` is a restore from the trash; restoring an old version is an `update`. */
export type WriteAction = "create" | "update" | "publish" | "unpublish" | "restore";

/** The editor or agent behind a request. */
export interface Session {
  /** Stable identity: `<issuer>|<sub>`, or `dev` locally. */
  sub: string,
  email?: string,
  name?: string,
  /** Roles from the identity provider's claim and `permissions.users`; `["dev"]` for the dev sign-in. */
  roles: string[]
}

/**
 * The document types a hook map works with, keyed by content type. Plugins
 * written for any site use the default (plain JSON); a site's own plugin can
 * pass its config to `defineServer` and get the site's real types.
 */
export type ContentTypes = { [type: string]: { stored: DocumentData, output: DocumentData } };

/** A config's content types as `{ stored, output }` pairs, for typing hooks. */
export type ContentTypesOf<C> = C extends { schemas: infer S }
  ? { [T in keyof S & string]: S[T] extends CollectionMarker<any, infer O> ? { stored: Input<O>, output: Output<O> } : never }
  : ContentTypes;

interface WriteInput<T extends string> {
  type: T,
  id: string,
  locale: string,
  action: WriteAction,
  session?: Session
}

/**
 * The document a transforming hook may change. It carries the content type
 * and whether the document validated, so narrowing on `output.type` and
 * `output.valid` narrows `output.doc` (TypeScript can't narrow one parameter
 * from a check on another).
 */
export type WriteOutput<D extends ContentTypes> = {
  [T in keyof D & string]:
    | { type: T, valid: true, doc: D[T]["stored"] }
    | { type: T, valid: false, doc: DocumentData }
}[keyof D & string];

/** `doc` is the saved draft on create and update, the published document on publish, and `null` otherwise. */
type AfterWriteInput<D extends ContentTypes> = {
  [T in keyof D & string]:
    | { type: T, id: string, locale: string, action: WriteAction, valid: true, doc: D[T]["stored"] }
    | { type: T, id: string, locale: string, action: WriteAction | "delete", valid: false, doc: DocumentData | null }
}[keyof D & string];

/** The document a `content.read` hook may change. Narrow on `output.type` and `output.drafts` for a typed published document. */
export type ReadOutput<D extends ContentTypes> = {
  [T in keyof D & string]:
    | { type: T, drafts: false, doc: D[T]["output"] & { id: string } }
    | { type: T, drafts: true, doc: DocumentData }
}[keyof D & string];

/**
 * What a plugin's server entry returns. Transform hooks run in config order and
 * change `output` in place; `content.afterWrite` only observes. See `vibe-cms docs server-hooks`.
 */
export interface ServerHooks<D extends ContentTypes = ContentTypes> {
  /** transform: normalize raw input before schema validation, on create, update and publish. Nothing is validated yet. */
  "content.beforeValidate"?: (
    input: WriteInput<keyof D & string>,
    output: { doc: DocumentData }
  ) => void | Promise<void>,
  /**
   * transform: derive fields, enforce rules. Throw to reject the write (422 with the message).
   * Drafts may be incomplete (`valid: false`); publishing always passes a
   * valid document. Fields you set must exist in the schema: the result is
   * validated again, and anything undeclared is dropped.
   */
  "content.beforeWrite"?: (input: WriteInput<keyof D & string> & { valid: boolean }, output: WriteOutput<D>) => void | Promise<void>,
  /** observe: cache purges, webhooks, indexing. Runs after the response via `waitUntil`. */
  "content.afterWrite"?: (input: AfterWriteInput<D>) => void | Promise<void>,
  /** transform: set `output.cancel` to a message to block the delete (409). Not run when deleting one translation. */
  "content.beforeDelete"?: (
    input: { type: keyof D & string, id: string, session?: Session },
    output: { cancel?: string }
  ) => void | Promise<void>,
  /** transform: shape documents queries return. Published reads are valid; drafts may not be. Editor lists and forms skip it. */
  "content.read"?: (input: { type: keyof D & string, drafts: boolean }, output: ReadOutput<D>) => void | Promise<void>,
  /** register: metadata extractors keyed by MIME pattern, e.g. `"video/*"`. They get the first 256 KB; the result is merged into the asset's `meta`. */
  "media.analyze"?: Record<string, (bytes: Uint8Array, mime: string) => AssetMeta | Promise<AssetMeta>>,
  /** transform: validate or rename uploads, or pick their folder. Set `output.reject` to refuse (422). */
  "media.beforeUpload"?: (
    input: { mime: string, size: number, session?: Session },
    output: { filename: string, folder: string | null, reject?: string }
  ) => void | Promise<void>,
  /**
   * register: routes under `/_vibe/plugins/<name>/` (not `/_vibe/api/`), keyed by `"METHOD /path"`;
   * `:param` segments and a trailing `*` allowed. Routes are public: check `session` yourself.
   * See `vibe-cms docs plugin-routes`.
   */
  routes?: Record<string, (request: Request, context: RouteContext) => Response | Promise<Response>>,
  /** register: cron jobs keyed by schedule. The schedule must also be a trigger on the Worker. */
  cron?: Record<string, () => void | Promise<void>>,
  /** register: queue consumers keyed by queue name. */
  queues?: Record<string, (batch: MessageBatch) => void | Promise<void>>
}

/** The second argument of a route handler. */
export interface RouteContext {
  params: Record<string, string>,
  /** The editor or agent, from a bearer token or the editor's cookie; `null` for anonymous requests. */
  session: Session | null
}

/** Where plugin logs go: the Worker's console. */
export interface Logger {
  info(...args: unknown[]): void,
  warn(...args: unknown[]): void,
  error(...args: unknown[]): void
}

/** What a plugin's server entry is called with, once per Worker isolate. */
export interface ServerContext<B = unknown, O = unknown> {
  /** The plugin's binding contract, as the site supplies it in `createHandler({ bindings })` under the plugin's name. */
  bindings: B,
  /** What the site passed to the plugin's factory in the config. */
  options: O,
  /** In-process content access, read only. Drafts are allowed: server plugins are trusted. */
  cms: QueryClient<AnyConfig>,
  /** The Worker's whole `env`. Prefer a binding contract. */
  env: unknown,
  log: Logger
}

type BindingsOf<P> = P extends (...args: any[]) => PluginDescriptor<infer B, any, any> ? B : never;
type OptionsOf<P> = P extends (...args: any[]) => PluginDescriptor<any, infer O, any> ? O : never;

/** A plugin's server entry: context in, hooks out. */
export type ServerPlugin<B = any, O = any, D extends ContentTypes = ContentTypes> =
  (context: ServerContext<B, O>) => ServerHooks<D> | Promise<ServerHooks<D>>;

/**
 * Defines a plugin's server entry. Pass the plugin factory's type for typed
 * bindings and options, and, for a site's own plugin, `typeof config` for
 * typed documents in hooks. Default-export the result from a `*.server.ts` file
 * named by the descriptor's `server`. See `vibe-cms docs plugins`.
 *
 * ```ts
 * export default defineServer<typeof SlugsPlugin, typeof config>(({ options, cms }) => ({
 *   "content.beforeWrite": (input, output) => { … }
 * }));
 * ```
 */
export function defineServer<P extends (...args: any[]) => PluginDescriptor<any, any, any>, C = unknown>(
  plugin: ServerPlugin<BindingsOf<P>, OptionsOf<P>, ContentTypesOf<C>>
): ServerPlugin<BindingsOf<P>, OptionsOf<P>, ContentTypesOf<C>> {
  return plugin;
}
