import { serializeConfig, type AnyConfig } from "../config.ts";
import type { PluginDescriptor } from "../descriptor.ts";
import { createQueryClient, type QueryClient } from "../query/index.ts";
import { handleRequest, readCookie, siteId } from "./api.ts";
import { can, verifySession } from "./auth.ts";
import { migrate, sha256 } from "./db.ts";
import { Engine, type EngineState, type SiteSettings } from "./engine.ts";
import type { D1, ExecutionContext, Fetcher, MessageBatch, R2, ScheduledEvent } from "./platform.ts";
import { PluginHost } from "./plugins.ts";
import { decoratePreview, PREVIEW_COOKIE, PREVIEW_TTL, previewCookie, previewScope, wantsPreview, type PreviewScope } from "./preview.ts";

export type * from "./platform.ts";
export { Engine, type SiteSettings, type SiteSettingsPatch } from "./engine.ts";
export { isPreview } from "./preview.ts";

export interface CoreBindings {
  /** D1 database holding content, versions and the media library index. */
  db: D1,
  /** R2 bucket for uploads. Optional if you never upload media. */
  storage?: R2,
  /** Static assets binding, used to serve the editor's deep links. Defaults to `env.ASSETS`. */
  assets?: Fetcher
}

type PluginsOf<C> = C extends { plugins?: ReadonlyArray<infer P> } ? P : never;

type PluginBindings<C> = {
  [P in PluginsOf<C> as P extends PluginDescriptor<infer B, any, infer N> ? ({} extends B ? never : N) : never]:
  P extends PluginDescriptor<infer B, any, any> ? B : never
};

/** Core bindings plus every plugin's `definePlugin<B>()` contract, keyed by plugin name. */
export type Bindings<C> = CoreBindings & PluginBindings<C>;

export interface HandlerOptions<C, E> {
  /**
   * Maps your Worker's `env` to the CMS's resources, plus each plugin's bindings under its name.
   * Called per request, so it can read `env` freely.
   */
  bindings: (env: E) => Bindings<C>,
  /**
   * Development mode: the editor, the CLI and local agents sign in as a developer with every
   * permission, without an identity provider. Defaults to Vite's `import.meta.env.DEV`, so it's
   * false in builds and outside Vite (set it yourself under plain wrangler). Never true in production.
   */
  dev?: boolean
}

/** Your Worker's own handlers, which get everything the CMS doesn't handle. */
export interface WorkerHandlers<E> {
  fetch?: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>,
  scheduled?: (event: ScheduledEvent, env: E, ctx: ExecutionContext) => void | Promise<void>,
  queue?: (batch: MessageBatch, env: E, ctx: ExecutionContext) => void | Promise<void>
}

/** A complete Worker module export: `export default vibe({ fetch })`. */
export interface WorkerExport<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>,
  scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>,
  queue(batch: MessageBatch, env: E, ctx: ExecutionContext): Promise<void>
}

/** The CMS mounted in your Worker. Call it to wrap your handlers, or use its methods to route requests yourself. */
export interface VibeHandler<C extends AnyConfig, E> {
  /**
   * Wraps your Worker's handlers. Requests under the prefix (`/_vibe`) and `/.well-known/vibe-cms` go to the
   * CMS, the rest to `fetch`. `scheduled` runs scheduled publishing, trash purging and plugin cron jobs, then
   * yours. `queue` runs the plugin consumer for that queue, else yours, else throws.
   */
  (handlers?: WorkerHandlers<E>): WorkerExport<E>,
  /** Whether a request belongs to the CMS, for routing it yourself. */
  match(request: Request): boolean,
  /** Answers a request that `match` accepted. */
  handle(request: Request, env: E, ctx: ExecutionContext): Promise<Response>,
  /** The CMS's cron work: scheduled publishing, trash purging, plugin cron jobs. */
  scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>,
  /** Returns true when the batch belonged to a CMS or plugin queue. */
  queue(batch: MessageBatch, env: E, ctx: ExecutionContext): Promise<boolean>,
  /**
   * In-process, typed reads of published content for your site's code. No HTTP, no token. During an
   * editor's draft preview it reads drafts instead, of the types that editor can read. See `vibe-cms docs queries`.
   */
  client(env: E): QueryClient<C>,
  /** The site's name, accent and icon as editors set them in the editor's Site settings (asset URLs are root-relative). */
  site(env: E): Promise<SiteSettings>,
  /** The config it was created with. */
  config: C
}

function readDevFlag(): boolean {
  try {
    return (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;
  } catch {
    return false;
  }
}

/** Fails clearly when the deployed Worker lacks a binding the types promised. */
function checkBindings(config: AnyConfig, bindings: Record<string, unknown>) {
  if(!bindings.db) throw new Error("vibe-cms: binding \"db\" is undefined. Check the D1 binding in your wrangler/Alchemy config.");
  for(const plugin of config.plugins ?? []) {
    const provided = bindings[plugin.name];
    if(provided === undefined) continue;
    for(const [key, value] of Object.entries(provided as Record<string, unknown>)) {
      if(value === undefined) {
        throw new Error(
          `vibe-cms: plugin "${plugin.name}" binding "${key}" is undefined.\nCheck the binding in your wrangler/Alchemy config.`
        );
      }
    }
  }
}

/**
 * Creates the CMS for your Worker from the config and the bindings it gets. Nothing is provisioned:
 * the database's tables are created on the first request each isolate handles.
 *
 * ```ts
 * export const vibe = createHandler(config, { bindings: env => ({ db: env.DB, storage: env.MEDIA }) });
 * export default vibe({ fetch: (request, env) => new Response("Hello") });
 * ```
 *
 * See `vibe-cms docs getting-started`.
 */
export function createHandler<C extends AnyConfig, E = any>(config: C, options: HandlerOptions<C, E>): VibeHandler<C, E> {
  const prefix = (config.prefix ?? "/_vibe").replace(/\/$/, "");
  const dev = options.dev ?? readDevFlag();
  const states = new WeakMap<object, Promise<EngineState>>();
  const schemaHash = sha256(JSON.stringify(serializeConfig(config).schemas)).then(h => h.slice(0, 16));

  function state(env: E): Promise<EngineState> {
    const key = (env ?? {}) as object;
    let promise = states.get(key);
    if(!promise) {
      promise = init(env);
      promise.catch(() => states.delete(key));
      states.set(key, promise);
    }
    return promise;
  }

  async function init(env: E): Promise<EngineState> {
    const bindings = options.bindings(env) as Bindings<C> & Record<string, unknown>;
    checkBindings(config, bindings);
    await migrate(bindings.db, config);
    const partial = {
      config,
      db: bindings.db,
      storage: bindings.storage,
      schemaHash: await schemaHash,
      prefix
    };
    const plugins = await PluginHost.load((config.plugins ?? []) as PluginDescriptor[], plugin => ({
      bindings: bindings[plugin.name],
      options: plugin.options,
      env,
      log: console,
      cms: createQueryClient(queries => new Engine(full, { origin: "", session: null, trusted: true }).execute(queries))
    }));
    const full: EngineState = { ...partial, plugins };
    return full;
  }

  function match(request: Request): boolean {
    const { pathname } = new URL(request.url);
    return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname === "/.well-known/vibe-cms";
  }

  async function handle(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
    const bindings = options.bindings(env) as CoreBindings;
    const assets = bindings.assets ?? (env as { ASSETS?: Fetcher } | undefined)?.ASSETS;
    return handleRequest(request, { state: await state(env), dev, assets, ctx });
  }

  async function scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void> {
    const s = await state(env);
    const engine = new Engine(s, { origin: "", session: null, trusted: true, ctx });
    const jobs: Array<Promise<unknown>> = [engine.runSchedules(event.scheduledTime), engine.purgeExpiredTrash(event.scheduledTime)];
    for(const plugin of s.plugins.plugins) {
      const job = plugin.hooks.cron?.[event.cron];
      if(job) jobs.push(Promise.resolve(job()));
    }
    const results = await Promise.allSettled(jobs);
    for(const result of results) {
      if(result.status === "rejected") console.error("vibe-cms: scheduled job failed", result.reason);
    }
  }

  async function queue(batch: MessageBatch, env: E): Promise<boolean> {
    const s = await state(env);
    for(const plugin of s.plugins.plugins) {
      const consumer = plugin.hooks.queues?.[batch.queue];
      if(consumer) {
        await consumer(batch);
        return true;
      }
    }
    return false;
  }

  function client(env: E): QueryClient<C> {
    return createQueryClient<C>(async queries => {
      const engine = new Engine(await state(env), { origin: "", session: null, trusted: true });
      const preview = previewScope.getStore();
      if(!preview) return engine.execute(queries);
      return engine.execute(queries.map(query => (can(config, preview.session, { action: "read", type: query.type }) ? { ...query, drafts: true } : query)));
    });
  }

  /** A preview cookie's session, if it's still valid and the request is a framed preview page (`wantsPreview`). */
  async function previewSession(request: Request, env: E): Promise<(PreviewScope & { token: string }) | null> {
    const token = readCookie(request, PREVIEW_COOKIE);
    if(!token || !wantsPreview(request)) return null;
    const session = await verifySession((await state(env)).db, token, siteId(config, new URL(request.url)));
    return session ? { session, token } : null;
  }

  async function site(env: E): Promise<SiteSettings> {
    return new Engine(await state(env), { origin: "", session: null, trusted: true }).site(config.id ?? "site");
  }

  function vibe(handlers: WorkerHandlers<E> = {}): WorkerExport<E> {
    return {
      async fetch(request, env, ctx) {
        if(match(request)) return handle(request, env, ctx);
        if(!handlers.fetch) return new Response("Not found", { status: 404 });
        const preview = await previewSession(request, env);
        if(!preview) return handlers.fetch(request, env, ctx);
        const renew = previewCookie(preview.token, PREVIEW_TTL, new URL(request.url).protocol === "https:");
        return previewScope.run(preview, async () => decoratePreview(await handlers.fetch!(request, env, ctx), prefix, renew));
      },
      async scheduled(event, env, ctx) {
        await Promise.all([scheduled(event, env, ctx), handlers.scheduled?.(event, env, ctx)]);
      },
      async queue(batch, env, ctx) {
        if(await queue(batch, env)) return;
        if(handlers.queue) return handlers.queue(batch, env, ctx);
        throw new Error(`vibe-cms: no consumer for queue "${batch.queue}"`);
      }
    };
  }

  return Object.assign(vibe, { match, handle, scheduled, queue, client, site, config });
}
