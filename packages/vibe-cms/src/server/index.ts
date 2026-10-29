import type { PluginDescriptor } from "../descriptor.ts";
import type { AnyConfig } from "../config.ts";
import type { QueryClient } from "../query/index.ts";
import type { AssetMeta } from "../schema/types.ts";
import type { MessageBatch } from "../handler/platform.ts";

export type WriteAction = "create" | "update" | "publish" | "unpublish" | "restore";

export interface Session {
  /** Stable identity: `<issuer>|<sub>`, or `dev` locally. */
  sub: string,
  email?: string,
  name?: string,
  roles: string[]
}

export interface ServerHooks {
  /** transform: normalize input before schema validation. */
  "content.beforeValidate"?: (
    input: { type: string, id: string, locale: string, action: WriteAction, session?: Session },
    output: { doc: Record<string, unknown> }
  ) => void | Promise<void>,
  /** transform: derive fields, enforce rules. Throw to reject the write. */
  "content.beforeWrite"?: (
    input: { type: string, id: string, locale: string, action: WriteAction, session?: Session },
    output: { doc: Record<string, unknown> }
  ) => void | Promise<void>,
  /** observe: cache purges, webhooks, indexing. Runs after the response via `waitUntil`. */
  "content.afterWrite"?: (input: {
    type: string,
    id: string,
    locale: string,
    action: WriteAction | "delete",
    doc: Record<string, unknown> | null
  }) => void | Promise<void>,
  /** transform: set `output.cancel` to a message to block the delete. */
  "content.beforeDelete"?: (
    input: { type: string, id: string, session?: Session },
    output: { cancel?: string }
  ) => void | Promise<void>,
  /** transform: shape documents on the way out. */
  "content.read"?: (
    input: { type: string, drafts: boolean },
    output: { doc: Record<string, unknown> }
  ) => void | Promise<void>,
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

export type ServerPlugin<B = any, O = any> = (context: ServerContext<B, O>) => ServerHooks | Promise<ServerHooks>;

/** Defines a plugin's server entry. Pass the plugin factory's type for typed bindings and options. */
export function defineServer<P extends (...args: any[]) => PluginDescriptor<any, any, any>>(
  plugin: ServerPlugin<BindingsOf<P>, OptionsOf<P>>
): ServerPlugin<BindingsOf<P>, OptionsOf<P>> {
  return plugin;
}
