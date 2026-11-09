# Plugins

How to write a plugin: the descriptor in the config, a server entry for hooks and routes, an admin entry for the editor, bindings, and Durable Objects.

## What a plugin can do

A plugin is how a site adds behaviour to the CMS itself: code that runs when content changes, endpoints the site or editor calls, and screens inside the editor. Everything a plugin does is opt-in per site, and a plugin can do any combination of it.

| Area | What it can do | Topic |
|---|---|---|
| Writes | Fill or derive fields (slugs, reading time, search text), normalise values, refuse a write or delete with a reason | `vibe-cms docs server-hooks` |
| After changes | React to a publish or delete: purge a cache, send a webhook, rebuild a search index, notify a channel | `vibe-cms docs server-hooks` |
| Reads | Adjust documents as queries return them | `vibe-cms docs server-hooks` |
| Media | Check or transform uploads, extract metadata (duration, colours, EXIF) | `vibe-cms docs server-hooks` |
| Background work | Cron jobs and queue consumers: syncing content out to other systems, reports, cleanup | `vibe-cms docs server-hooks` |
| HTTP | Routes under `/_vibe/plugins/<name>/` for forms, search, webhooks from other services, or data for the editor | `vibe-cms docs plugin-routes` |
| Actions | Named operations with typed input, run over REST and the CLI, and offered to AI agents as tools when you choose | `vibe-cms docs plugin-actions` |
| Editor | Whole pages with nav links, document sidebars and actions, list columns, commands, field decorators | `vibe-cms docs admin-extensions` |
| Fields | Custom editor widgets for a field (a map picker, a colour swatch, a lookup in another system) | `vibe-cms docs widgets` |
| Cloudflare | Its own bindings (KV, queues, Durable Objects, Workflows, secrets), supplied by the site | Below |

Typical plugins: a contact form route that validates submissions and emails them; a search index kept in sync on every publish; a cron job that pushes published products to an external store; an SEO panel in the document sidebar; a deploy hook that rebuilds a static frontend. A plugin can be specific to one site, living in `src/plugins/`, or published as a package for many.

## Files

A plugin is three files, each loaded in a different place:

| File | Exports | Loaded by |
|---|---|---|
| `index.ts` | the descriptor factory, from `definePlugin` | the config, so the Worker and the editor |
| `plugin.server.ts` | `export default defineServer(…)`: hooks, routes, cron, queues | the Worker only |
| `plugin.admin.tsx` | `export default defineAdmin(…)`: pages, nav, slots, commands | the editor only |

The descriptor names the other two with lazy `import()`s, so importing the config never loads server or editor code. The `vibe()` Vite plugin also stubs any `*.admin.*` file outside the editor and any `*.server.*` file in browser code, so keep those suffixes. A plugin needs at least one of `server` and `admin`.

The examples in this topic come from `examples/plugins` in the vibe-cms repository, which has one plugin per feature:

| Plugin | Shows |
|---|---|
| `slugs` | Filling and deriving fields (`content.beforeValidate`, `content.beforeWrite`) |
| `rules` | Refusing writes and deletes, reading drafts with `cms` |
| `webhook` | `content.afterWrite`, plugin options, a binding contract |
| `stats` | HTTP routes, an editor page with a nav link (`vibe-cms docs plugin-routes`), an action for agents (`vibe-cms docs plugin-actions`) |
| `editor` | Document sidebar and actions, list columns, commands, field decorators (`vibe-cms docs admin-extensions`) |
| `scheduled` | `cron` and `queues` |
| `media` | `media.beforeUpload` and `media.analyze` |
| `counter` | A Durable Object exported through `vibe-cms/exports` |

## The descriptor

```ts
// examples/plugins/src/rules/index.ts
import { definePlugin } from "vibe-cms";

export interface RulesOptions {
  /** Posts whose title contains one of these can't be published. */
  blockedWords: string[]
}

/** Refuses some writes and deletes. */
export const RulesPlugin = definePlugin()((options: RulesOptions) => ({
  name: "rules",
  options,
  server: () => import("./plugin.server.ts")
}));
```

- `definePlugin` is curried: the first call takes the binding contract as a type argument (below), the second takes your factory, whose parameters become the plugin's options.
- `name` is the plugin's ID. It must be letters, digits, `_` or `-`: it appears in URLs (`/_vibe/plugins/<name>/…`, `/_vibe/admin/p/<name>/…`) and keys the bindings.
- `options` must be plain data. They reach the server entry as `options`; the editor doesn't receive them.

Register plugins in the config. Transforming hooks run in this order, each seeing the previous plugin's changes:

```ts
// examples/plugins/vibe-cms.config.ts
  plugins: [
    SlugsPlugin(),
    RulesPlugin({ blockedWords: ["TODO"] }),
    WebhookPlugin({ types: ["post"] }),
    StatsPlugin(),
    EditorPlugin(),
    ScheduledPlugin(),
    MediaPlugin({ maxSize: 10_000_000 }),
    CounterPlugin()
  ],
```

## The server entry

The default export is a function from the plugin's context to its hooks. It runs once per Worker isolate, on the first request, and may be async.

```ts
// examples/plugins/src/rules/plugin.server.ts
import { defineServer } from "vibe-cms/server";
import config from "../../vibe-cms.config.ts";
import type { RulesPlugin } from "./index.ts";

const { post } = config.schemas;

export default defineServer<typeof RulesPlugin, typeof config>(({ options, cms }) => ({
```

The context:

| Field | What it is |
|---|---|
| `options` | What the site passed to the factory, typed from the descriptor |
| `bindings` | The plugin's binding contract, as supplied in `createHandler` |
| `cms` | An in-process query client (`vibe-cms docs queries`). Trusted, so `drafts: true` works. Read only: there is no in-process write client |
| `env` | The Worker's whole `env`, untyped |
| `log` | `info`, `warn`, `error` (the console) |

`defineServer<typeof Plugin>` types `options` and `bindings`. A site's own plugin can add `typeof config` as a second type argument to type documents in hooks against the site's schemas; a plugin written for any site leaves it out and gets plain JSON (`DocumentData`). A server entry may import the config itself, as the one above does, to query its collections.

Every hook is described in `vibe-cms docs server-hooks`; routes in `vibe-cms docs plugin-routes`; actions in `vibe-cms docs plugin-actions`.

## The admin entry

```ts
// examples/plugins/src/stats/plugin.admin.tsx
export default defineAdmin(() => ({
  // Page keys and nav `to` are relative to the plugin: the editor prefixes them with /p/stats.
  pages: {
    "/": { title: "Stats", component: StatsPage },
    "/words/:slug": { title: "Words", component: WordsPage }
  },
  slots: {
    nav: [{ label: "Stats", to: "/", icon: "chart-bar" }]
  }
}));
```

The factory gets `{ cms }`, the editor's client, and runs once when the editor loads. If it throws, the editor logs the error and carries on without the plugin. See `vibe-cms docs admin-extensions` for everything it can return.

## Bindings

A plugin that needs Cloudflare resources declares them as the type argument of `definePlugin`. The site supplies them in `createHandler`, under the plugin's name; leaving one out is a type error, and an `undefined` value at runtime fails the first request with the plugin and binding named.

```ts
// examples/plugins/src/webhook/index.ts
export const WebhookPlugin = definePlugin<{ url: string }>()((options: WebhookOptions = {}) => ({
  name: "webhook",
  options,
  server: () => import("./plugin.server.ts")
}));
```

```ts
// examples/plugins/src/cms.ts
// Each plugin's binding contract is supplied under its name; a missing one is a type error.
export const vibe = createHandler(config, {
  bindings: (env: Env) => ({
    db: env.DB,
    storage: env.MEDIA,
    webhook: { url: env.WEBHOOK_URL },
    counter: { counters: env.COUNTERS }
  })
});
```

Bindings can be anything: KV namespaces, Durable Object namespaces, queues, or plain values such as a URL from a Worker variable.

## Durable Objects and Workflows

Cloudflare needs Durable Object and Workflow classes exported from the Worker's entry module. A plugin lists its classes in `exports`, and the site's entry re-exports them all with one line:

```ts
// examples/plugins/src/counter/index.ts
export const CounterPlugin = definePlugin<{
  counters: DurableObjectNamespace<Counter>
}>()(() => ({
  name: "counter",
  options: {},
  server: () => import("./plugin.server.ts"),
  exports: { from: import.meta.url, names: ["Counter"] }
}));
```

```ts
// examples/plugins/src/worker.ts
// Durable Object classes declared by plugins (here, the counter's), re-exported by the vibe() Vite plugin.
export * from "vibe-cms/exports";
```

`from` is the module that exports the classes (usually the descriptor's own `import.meta.url`, which must re-export them). `vibe-cms/exports` only works through the `vibe()` Vite plugin; without Vite, export the classes from your entry yourself. The Durable Object binding and its migration still go in your wrangler config.

## Publishing a plugin as a package

A plugin package depends on `vibe-cms` as a peer dependency and exports its descriptor factory. Packages in the site's `package.json` that depend on `vibe-cms` are picked up by the editor build automatically: their `*.admin.*` files are pre-bundled and their files are Tailwind sources, so admin components can use utility classes. Type documents as `DocumentData` (no `typeof config`), and take content type names as options.
