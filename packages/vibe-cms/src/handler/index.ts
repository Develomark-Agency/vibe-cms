import { serializeConfig, type AnyConfig } from "../config.ts";
import type { PluginDescriptor } from "../descriptor.ts";
import { createQueryClient, type QueryClient } from "../query/index.ts";
import { handleRequest } from "./api.ts";
import { migrate, sha256 } from "./db.ts";
import { Engine, type EngineState, type SiteSettings } from "./engine.ts";
import type { D1, ExecutionContext, Fetcher, MessageBatch, R2, ScheduledEvent } from "./platform.ts";
import { PluginHost } from "./plugins.ts";

export type * from "./platform.ts";
export { Engine, type SiteSettings, type SiteSettingsPatch } from "./engine.ts";

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
  bindings: (env: E) => Bindings<C>,
  /**
   * Development mode: the editor can sign in without an identity provider.
   * Defaults to Vite's `import.meta.env.DEV`.
   */
  dev?: boolean
}

export interface WorkerHandlers<E> {
  fetch?: (request: Request, env: E, ctx: ExecutionContext) => Response | Promise<Response>,
  scheduled?: (event: ScheduledEvent, env: E, ctx: ExecutionContext) => void | Promise<void>,
  queue?: (batch: MessageBatch, env: E, ctx: ExecutionContext) => void | Promise<void>
}

export interface WorkerExport<E> {
  fetch(request: Request, env: E, ctx: ExecutionContext): Promise<Response>,
  scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>,
  queue(batch: MessageBatch, env: E, ctx: ExecutionContext): Promise<void>
}

export interface VibeHandler<C extends AnyConfig, E> {
  /** Wraps your Worker's handlers: CMS requests, cron work and queues are routed to the CMS. */
  (handlers?: WorkerHandlers<E>): WorkerExport<E>,
  /** Whether a request belongs to the CMS. */
  match(request: Request): boolean,
  handle(request: Request, env: E, ctx: ExecutionContext): Promise<Response>,
  scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void>,
  /** Returns true when the batch belonged to a CMS or plugin queue. */
  queue(batch: MessageBatch, env: E, ctx: ExecutionContext): Promise<boolean>,
  /** In-process content access for your site's code. */
  client(env: E): QueryClient<C>,
  /** The site's name, accent and icon as editors set them in the editor's Site settings (asset URLs are root-relative). */
  site(env: E): Promise<SiteSettings>,
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
      return engine.execute(queries);
    });
  }

  async function site(env: E): Promise<SiteSettings> {
    return new Engine(await state(env), { origin: "", session: null, trusted: true }).site(config.id ?? "site");
  }

  function vibe(handlers: WorkerHandlers<E> = {}): WorkerExport<E> {
    return {
      async fetch(request, env, ctx) {
        if(match(request)) return handle(request, env, ctx);
        if(handlers.fetch) return handlers.fetch(request, env, ctx);
        return new Response("Not found", { status: 404 });
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
