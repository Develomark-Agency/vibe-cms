# The handler

vibe-cms is a library, not infrastructure. You already have a Worker for your site (Astro, Vinext, React Router, plain Vite); the CMS mounts inside it. One Worker per site serves both the site and the CMS.

## `createHandler`

```ts
// src/worker.ts
import config from "../vibe-cms.config";
import { createHandler } from "vibe-cms/handler";
import handler from "vinext/server/fetch-handler";

export * from "vibe-cms/exports"; // plugin Durable Object / Workflow classes

const vibe = createHandler(config, {
  bindings: (env: Env) => ({
    // core
    db: env.DB,
    storage: env.MEDIA,

    // plugins, keyed by plugin name, typed from each plugin's contract
    search: {
      cache: env.SEARCH_KV,
      sessions: env.SEARCH_SESSIONS,
    },
  }),
});

export default vibe({
  async fetch(req, env, ctx) {
    return handler.fetch(req, env, ctx);
  },
});
```

`createHandler` takes the config **value**, not just its type: the handler runs schema validation and plugin hooks at runtime.

### Typed binding mapping

The `bindings` function's return type is derived from the config: core bindings plus every plugin's `definePlugin<B>()` contract. `Env` comes from wherever you already get it (`wrangler types`, Alchemy's inferred worker env, hand-written).

```ts
const vibe = createHandler(config, {
  bindings: (env: Env) => ({
    db: env.DB,
    storage: env.MEDIA,
    search: { cache: env.SEARCH_KV },
    //       ~~~~~~~~~~~~~~~~~~~~~~~~
    // ✗ Property 'sessions' is missing; required by plugin "search"
  }),
});
```

An explicit mapping (instead of required binding names) means you keep your own naming and can point at resources that already exist.

### Runtime binding check

Types can say a binding exists when the deployed config doesn't have it. On first request, the handler walks the returned mapping and fails clearly:

```
vibe-cms: plugin "search" binding "sessions" is undefined.
Check the Durable Object binding in your wrangler/Alchemy config.
```

## Wrapping the Worker export: `vibe({...})`

The CMS needs more than `fetch`: scheduled publishing needs `scheduled`, and plugins may register queue consumers and cron jobs. `vibe()` takes your handlers and returns a complete Worker export:

```ts
export default vibe({
  async fetch(req, env, ctx) {
    // only called for requests the CMS didn't claim
    return app.fetch(req, env, ctx);
  },
  async scheduled(event, env, ctx) {
    // your own cron work; CMS cron work is merged in
  },
  async queue(batch, env, ctx) {
    // your own queues; CMS and plugin queues are routed separately
  },
});
```

- `fetch`: requests under `/_vibe/*` go to the CMS; everything else goes to yours.
- `scheduled`: CMS jobs (scheduled publishing, purging expired trash, plugin `cron`) run alongside yours.
- `queue`: batches for CMS/plugin queues are routed to them; others go to yours.

## When the framework owns the entry: `match` / `handle`

```ts
export default {
  async fetch(req, env, ctx) {
    if (vibe.match(req)) {
      return vibe.handle(req, env, ctx);
    }
    return app.fetch(req, env, ctx);
  },
  scheduled: vibe.scheduled,
};
```

## Routes served by the handler

| Path | What |
|---|---|
| `/_vibe/api/*` | Content and admin HTTP API |
| `/_vibe/api/session/code` | Panel → site, server to server: provider ID token in, one-time code out |
| `/_vibe/api/session` | Editor → site: one-time code in, site session token out |
| `/_vibe/admin/*` | The site's editor, a standalone app (static assets, see [build.md](./build.md)) |
| `/_vibe/plugins/<name>/*` | Plugin routes |
| `/.well-known/vibe-cms` | Public site descriptor: which identity provider this site trusts (see [panel-and-auth.md](./panel-and-auth.md)) |

The `/_vibe` prefix is configurable.

## Trade-offs we accepted

- The CMS shares the site Worker's CPU and memory limits, and deploying CMS changes means deploying the site. Content edits never need a deploy.
- Engine and plugin server code count toward the Worker size limit (3 MB compressed on Free, 10 MB on Paid). The engine stays lean and plugin server code is loaded lazily.
- A dedicated CMS-only Worker is still possible: it is a Worker whose only code is `export default vibe({})`.
