import type { PluginDescriptor } from "../descriptor.ts";
import type { AnyConfig, CollectionMarker } from "../config.ts";
import type { QueryClient } from "../query/index.ts";
import type { AssetMeta, DocumentData, Input, Output } from "../schema/types.ts";
import type { MessageBatch } from "../handler/platform.ts";

export type WriteAction = "create" | "update" | "publish" | "unpublish" | "restore";

export interface Session {
  /** Stable identity: `<issuer>|<sub>`, or `dev` locally. */
  sub: string,
  email?: string,
  name?: string,
  roles: string[]
}

/**
 * The document types a hook map works with, keyed by content type. Plugins
 * written for any site use the default (plain JSON); a site's own plugin can
 * pass its config to `defineServer` and get the site's real types.
 */
export type ContentTypes = { [type: string]: { stored: DocumentData, output: DocumentData } };

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

type AfterWriteInput<D extends ContentTypes> = {
  [T in keyof D & string]:
    | { type: T, id: string, locale: string, action: WriteAction, valid: true, doc: D[T]["stored"] }
    | { type: T, id: string, locale: string, action: WriteAction | "delete", valid: false, doc: DocumentData | null }
}[keyof D & string];

export type ReadOutput<D extends ContentTypes> = {
  [T in keyof D & string]:
    | { type: T, drafts: false, doc: D[T]["output"] & { id: string } }
    | { type: T, drafts: true, doc: DocumentData }
}[keyof D & string];

export interface ServerHooks<D extends ContentTypes = ContentTypes> {
  /** transform: normalize raw input before schema validation. Nothing is validated yet. */
  "content.beforeValidate"?: (
    input: WriteInput<keyof D & string>,
    output: { doc: DocumentData }
  ) => void | Promise<void>,
  /**
   * transform: derive fields, enforce rules. Throw to reject the write.
   * Drafts may be incomplete (`valid: false`); publishing always passes a
   * valid document. Fields you set must exist in the schema: the result is
   * validated again, and anything undeclared is dropped.
   */
  "content.beforeWrite"?: (input: WriteInput<keyof D & string> & { valid: boolean }, output: WriteOutput<D>) => void | Promise<void>,
  /** observe: cache purges, webhooks, indexing. Runs after the response via `waitUntil`. */
  "content.afterWrite"?: (input: AfterWriteInput<D>) => void | Promise<void>,
  /** transform: set `output.cancel` to a message to block the delete. */
  "content.beforeDelete"?: (
    input: { type: keyof D & string, id: string, session?: Session },
    output: { cancel?: string }
  ) => void | Promise<void>,
  /** transform: shape documents on the way out. Published reads are valid; drafts may not be. */
  "content.read"?: (input: { type: keyof D & string, drafts: boolean }, output: ReadOutput<D>) => void | Promise<void>,
  /** register: metadata extractors keyed by MIME pattern, e.g. `"video/*"`. */
  "media.analyze"?: Record<string, (bytes: Uint8Array, mime: string) => AssetMeta | Promise<AssetMeta>>,
  /** transform: validate or rename uploads. Set `output.reject` to refuse. */
  "media.beforeUpload"?: (
    input: { mime: string, size: number, session?: Session },
    output: { filename: string, folder: string | null, reject?: string }
  ) => void | Promise<void>,
  /** register: routes under `/_vibe/plugins/<name>/`, keyed by `"METHOD /path"`; `:param` segments allowed. */
  routes?: Record<string, (request: Request, context: RouteContext) => Response | Promise<Response>>,
  /** register: cron jobs keyed by schedule. The schedule must also be a trigger on the Worker. */
  cron?: Record<string, () => void | Promise<void>>,
  /** register: queue consumers keyed by queue name. */
  queues?: Record<string, (batch: MessageBatch) => void | Promise<void>>
}

export interface RouteContext {
  params: Record<string, string>,
  /** The editor session, when the request carries one. */
  session: Session | null
}

export interface Logger {
  info(...args: unknown[]): void,
  warn(...args: unknown[]): void,
  error(...args: unknown[]): void
}

export interface ServerContext<B = unknown, O = unknown> {
  bindings: B,
  options: O,
  /** In-process content access. Drafts are allowed: server plugins are trusted. */
  cms: QueryClient<AnyConfig>,
  env: unknown,
  log: Logger
}

type BindingsOf<P> = P extends (...args: any[]) => PluginDescriptor<infer B, any, any> ? B : never;
type OptionsOf<P> = P extends (...args: any[]) => PluginDescriptor<any, infer O, any> ? O : never;

export type ServerPlugin<B = any, O = any, D extends ContentTypes = ContentTypes> =
  (context: ServerContext<B, O>) => ServerHooks<D> | Promise<ServerHooks<D>>;

/**
 * Defines a plugin's server entry. Pass the plugin factory's type for typed
 * bindings and options, and, for a site's own plugin, `typeof config` for
 * typed documents in hooks.
 */
export function defineServer<P extends (...args: any[]) => PluginDescriptor<any, any, any>, C = unknown>(
  plugin: ServerPlugin<BindingsOf<P>, OptionsOf<P>, ContentTypesOf<C>>
): ServerPlugin<BindingsOf<P>, OptionsOf<P>, ContentTypesOf<C>> {
  return plugin;
}
