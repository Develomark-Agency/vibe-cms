import { collectionInfo, serializeConfig, type AnyConfig, type CollectionMarker } from "../config.ts";
import type { PluginDescriptor } from "../descriptor.ts";
import { createQueryClient, type QueryClient } from "../query/index.ts";
import { createRouter } from "./router.ts";
import { readCookie } from "./http.ts";
import { can, verifySession } from "./auth.ts";
import { getOrCreateMeta, migrate, newId, sha256 } from "./db.ts";
import { Engine, type EngineState, type SiteSettings } from "./engine.ts";
import type { D1, ExecutionContext, Fetcher, ImagesBinding, MessageBatch, R2, ScheduledEvent } from "./platform.ts";
import { ImageHealth } from "./images.ts";
import { SiteOrg, type OrgEnv } from "./org.ts";
import { wellKnownPaths } from "./oauth.ts";
import { RoleStore } from "./roles.ts";
import { announceClaim, announceSetup, signInConfig, type SignInEnv } from "./signin.ts";
import type { EmailSender } from "./email.ts";
import { PluginHost } from "./plugins.ts";
import { environmentOf, PRODUCTION, robotsResponse, withNoindex, type EnvironmentEnv } from "./environment.ts";
import { decoratePreview, PICK_HEADER, PREVIEW_COOKIE, PREVIEW_TTL, previewCookie, previewScope, recordSources, wantsPreview, type PreviewScope } from "./preview.ts";

export type * from "./platform.ts";
export type { EmailMessage, EmailSender } from "./email.ts";
/** The page a headless CLI login lands on, showing the code to paste. The hub serves it too. */
export { codePage as oauthCodePage } from "../oauth/index.ts";
export { Engine, type SiteSettings, type SiteSettingsPatch } from "./engine.ts";
export { isPreview } from "./preview.ts";

export interface CoreBindings {
  /** D1 database holding content, versions and the media library index. */
  db: D1,
  /** R2 bucket for uploads. Optional if you never upload media. */
  storage?: R2,
  /**
   * Cloudflare's Images binding (`Images()` in Alchemy). Image URLs with `?w=` are then resized and
   * served as AVIF or WebP; without it they're served at full size and the editor warns. `false`
   * opts out of optimization and the warning. See `vibe-cms docs media`.
   */
  images?: ImagesBinding | false,
  /** Static assets binding, used to serve the editor's deep links. Defaults to `env.ASSETS`. */
  assets?: Fetcher,
  /**
   * Sends the CMS's email: invites, for sites that sign people in themselves. Any `{ send(message) }`,
   * wrapping Cloudflare's `send_email` binding or another provider. Without it, the editor shows links to copy.
   */
  email?: EmailSender
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
  /** The site's ID, name, accent and icon as editors set them on the editor's Site page, and its detected favicon (URLs are root-relative). */
  site(env: E): Promise<SiteSettings>,
  /**
   * The deployment's environment, from `VIBE_ENV`: `production` when unset (`development` under `dev`).
   * Anything else is kept out of search engines. See `vibe-cms docs staging`.
   */
  environment(env: E): string,
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
  // Each collection's schema, for telling which collection an expanded reference in a preview's results is from.
  const schemas = Object.fromEntries(Object.entries(config.schemas).map(([name, collection]) => [name, collectionInfo(collection as CollectionMarker).schema]));
  const schemaHash = sha256(JSON.stringify(serializeConfig(config).schemas)).then(h => h.slice(0, 16));
  // The site's own fetch handler, once `vibe(handlers)` wraps it: lets the CMS read the site's pages in-process.
  let siteHandler: WorkerHandlers<E>["fetch"];

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
    const roles = new RoleStore(bindings.db);
    await roles.refresh(true);
    const partial = {
      config,
      db: bindings.db,
      storage: bindings.storage,
      images: bindings.images,
      imageHealth: new ImageHealth(bindings.db, bindings.images),
      schemaHash: await schemaHash,
      prefix,
      roles,
      siteId: await getOrCreateMeta(bindings.db, "site_id", () => newId("site")),
      org: await SiteOrg.load(bindings.db, (env ?? {}) as OrgEnv),
      signIn: signInConfig((env ?? {}) as SignInEnv, bindings.email),
      siteFetch: (request: Request) => fetchSite(request, env)
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

  /**
   * Static files from the assets binding, pages from the site's handler. Anything they don't have goes
   * over the network, which is how a dev server's own static files (Vite's `public/`) are reached.
   */
  async function fetchSite(request: Request, env: E): Promise<Response> {
    // `as Request`: in a program with both the DOM lib and @cloudflare/workers-types, the two global `Request`
    // declarations merge and `clone()` returns workers-types' generic Request with its parameters unresolved,
    // which isn't assignable to `Request`. The value is the same request either way.
    function copy() {
      return request.clone() as Request;
    }
    const assets = (options.bindings(env) as CoreBindings).assets ?? (env as { ASSETS?: Fetcher } | undefined)?.ASSETS;
    const local = [
      assets && new URL(request.url).pathname !== "/" ? () => assets.fetch(copy()) : null,
      siteHandler ? () => siteHandler!(copy(), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext) : null
    ];
    for(const attempt of local) {
      const response = attempt ? await Promise.resolve().then(attempt).catch(() => null) : null;
      if(response?.ok) return response;
      await response?.body?.cancel();
    }
    return fetch(request);
  }

  const router = createRouter(prefix);
  const oauthPaths = wellKnownPaths(prefix);
  const rootWellKnown = new Set([...oauthPaths.authorizationServer, ...oauthPaths.protectedResource].filter(path => !path.startsWith(prefix)));

  function match(request: Request): boolean {
    const { pathname } = new URL(request.url);
    return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname === "/.well-known/vibe-cms" || rootWellKnown.has(pathname);
  }

  async function handle(request: Request, env: E, ctx: ExecutionContext): Promise<Response> {
    const bindings = options.bindings(env) as CoreBindings;
    const assets = bindings.assets ?? (env as { ASSETS?: Fetcher } | undefined)?.ASSETS;
    const s = await state(env);
    await s.roles.refresh();
    return Promise.resolve(router.fetch(request, { state: s, dev, assets, ctx }));
  }

  async function scheduled(event: ScheduledEvent, env: E, ctx: ExecutionContext): Promise<void> {
    const s = await state(env);
    const engine = new Engine(s, { origin: "", session: null, trusted: true, ctx });
    const jobs: Array<Promise<unknown>> = [
      engine.runSchedules(event.scheduledTime),
      engine.purgeExpiredTrash(event.scheduledTime),
      s.imageHealth?.refresh() ?? Promise.resolve()
    ];
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
      const results = await engine.execute(queries.map(query => (can(engine.state, preview.session, { action: "read", type: query.type }) ? { ...query, drafts: true } : query)));
      recordSources(schemas, preview.sources, queries.map(query => query.type), results);
      return results;
    });
  }

  /** A preview cookie's session, if it's still valid and the request is a framed preview page (`wantsPreview`). */
  async function previewSession(request: Request, env: E): Promise<(PreviewScope & { token: string }) | null> {
    const token = readCookie(request, PREVIEW_COOKIE);
    if(!token || !wantsPreview(request)) return null;
    const { db, siteId, roles } = await state(env);
    await roles.refresh();
    const session = await verifySession(db, token, siteId);
    if(!session) return null;
    return { session, token, sources: new WeakMap(), ...(request.headers.get(PICK_HEADER) === "1" ? { pick: true } : {}) };
  }

  async function site(env: E): Promise<SiteSettings> {
    return new Engine(await state(env), { origin: "", session: null, trusted: true }).site();
  }

  /** Environments (a deployed Worker's, one per isolate) that already had their first page request announce a new site's links. */
  const announcedFor = new WeakSet<object>();

  /**
   * A new site prints its setup and claim links to its logs. The CMS's own routes do that, but a first
   * visit to the site's pages never reaches them, so the first request of any kind does it too.
   */
  async function announceNewSite(request: Request, env: E): Promise<void> {
    const key = (env ?? {}) as object;
    if(dev || announcedFor.has(key)) return;
    announcedFor.add(key);
    try {
      const s = await state(env);
      const origin = new URL(request.url).origin;
      await announceSetup(s, origin);
      await announceClaim(s, origin);
    } catch (error) {
      console.error("vibe-cms: couldn't check whether this site needs its setup links", error);
    }
  }

  function environment(env: E): string {
    return environmentOf(env as EnvironmentEnv | undefined, dev);
  }

  /** Your site's pages, or the CMS's routes, with search engines kept away from anything but production. */
  async function respond(request: Request, env: E, ctx: ExecutionContext, handlers: WorkerHandlers<E>): Promise<Response> {
    if(environment(env) === PRODUCTION) return route(request, env, ctx, handlers);
    if(new URL(request.url).pathname === "/robots.txt") return robotsResponse();
    return withNoindex(await route(request, env, ctx, handlers));
  }

  async function route(request: Request, env: E, ctx: ExecutionContext, handlers: WorkerHandlers<E>): Promise<Response> {
    if(match(request)) return handle(request, env, ctx);
    ctx?.waitUntil?.(announceNewSite(request, env));
    if(!handlers.fetch) return new Response("Not found", { status: 404 });
    const preview = await previewSession(request, env);
    if(!preview) return handlers.fetch(request, env, ctx);
    const renew = previewCookie(preview.token, PREVIEW_TTL, new URL(request.url).protocol === "https:");
    return previewScope.run(preview, async () => decoratePreview(await handlers.fetch!(request, env, ctx), prefix, renew));
  }

  function vibe(handlers: WorkerHandlers<E> = {}): WorkerExport<E> {
    siteHandler = handlers.fetch;
    return {
      fetch: (request, env, ctx) => respond(request, env, ctx, handlers),
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

  return Object.assign(vibe, { match, handle, scheduled, queue, client, site, environment, config });
}
