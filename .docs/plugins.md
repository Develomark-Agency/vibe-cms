# Plugins

A plugin is a package that adds behavior to the CMS engine (server), the admin app, or both. Plugins are trusted code with no sandboxing.

The promise: **stable, named, typed extension points on two planes**. Every hook declares whether it *observes* or *transforms*, and hooks run in the order plugins appear in the config.

## Defining a plugin

```ts
// @acme/search/src/index.ts
import { definePlugin } from "vibe-cms";
import type { SessionDO } from "./session-do.server";

export { SessionDO } from "./session-do.server";

export interface SearchOptions {
  fields?: string[];
}

export const SearchPlugin = definePlugin<{
  cache: KVNamespace;
  sessions: DurableObjectNamespace<SessionDO>;
}>()((options: SearchOptions = {}) => ({
  name: "search",
  options,
  server: () => import("./plugin.server"),
  admin: () => import("./plugin.admin"),
}));
```

### Binding contracts are types only

The generic on `definePlugin<B>()` is a contract: the plugin needs these bindings, and the user must supply them in `createHandler` (see [handler.md](./handler.md)). The plugin declares no runtime value for them and provisions nothing.

The curried `definePlugin<B>()(...)` form exists because TypeScript can't infer some type parameters while you supply others explicitly.

### Server and admin entries

- `server` runs inside the Worker: hooks, routes, background jobs. It may touch secrets and bindings.
- `admin` runs in the browser: widgets, slots, pages.

They are separate because they run in different runtimes, not because of who sees them. The `.server` / `.admin` file convention keeps each side out of the other's bundle (see [build.md](./build.md)).

## Server plugins

Modelled on OpenCode's plugin shape: a function that receives context and returns a typed map of named hooks. Transforming hooks receive `(input, output)` and mutate `output`.

```ts
// @acme/search/src/plugin.server.ts
import { defineServer } from "vibe-cms/server";
import type { SearchPlugin } from "./index";

export default defineServer<typeof SearchPlugin>(async ({ bindings, options, cms, log }) => ({
  // observe
  "content.afterWrite": async ({ type, doc }) => {
    await bindings.cache.delete(`search:${type}`);
    const session = bindings.sessions.get(bindings.sessions.idFromName(type));
    await session.reindex(doc.id);
  },

  // transform: `output` carries `type` and `valid`, so narrowing it narrows `output.doc`.
  // `searchText` must be declared in the post schema; undeclared fields are dropped.
  "content.beforeWrite": async (input, output) => {
    if (output.type === "post" && output.valid) {
      output.doc.searchText = extractText(output.doc.body);
    }
  },

  routes: {
    "GET /search": async (req) => {
      const q = new URL(req.url).searchParams.get("q") ?? "";
      return Response.json(await search(bindings, q));
    },
  },

  cron: {
    "0 3 * * *": async () => rebuildIndex(bindings, cms),
  },
}));
```

### Server extension points

| Hook | Kind | Purpose |
|---|---|---|
| `content.beforeValidate` | transform | Normalize input before schema validation |
| `content.beforeWrite` | transform | Derive fields, enforce rules, reject writes |
| `content.afterWrite` | observe | Cache purges, webhooks, indexing |
| `content.beforeDelete` | transform | Block or cascade deletes |
| `content.read` | transform | Shape documents on the way out |
| `media.analyze` | register | Extract metadata by MIME type (core ships images; e.g. a plugin adds video duration) |
| `media.beforeUpload` | transform | Validate, rename, transform uploads |
| `schema.fieldTypes` | register | Add field types / presets |
| `routes` | register | Extra API routes under `/_vibe/plugins/<name>/` |
| `cron` | register | Scheduled jobs |
| `queues` | register | Queue consumers |

## Admin plugins

```tsx
// @acme/search/src/plugin.admin.tsx
import { defineAdmin } from "vibe-cms/admin";
import { SearchPage, ReindexButton, SearchScoreColumn } from "./ui";

export default defineAdmin(({ cms }) => ({
  pages: {
    "/search": { title: "Search", component: SearchPage },
  },
  slots: {
    nav: [{ label: "Search", to: "/search", icon: "search" }],
    "document.actions": [
      { id: "reindex", label: "Reindex", component: ReindexButton },
    ],
    "list.columns": [
      { type: "post", id: "score", label: "Search score", component: SearchScoreColumn },
    ],
  },
  commands: [
    { id: "search.rebuild", label: "Rebuild search index", run: () => cms.plugins.search.rebuild() },
  ],
}));
```

### Admin extension points

| Extension point | Purpose |
|---|---|
| `widgets` | Register widget implementations (usually implicit via descriptors) |
| `slots.nav` | Navigation entries |
| `slots["document.sidebar"]` | Panels beside the document editor |
| `slots["document.actions"]` | Buttons like publish, preview, "translate" |
| `slots["list.columns"]`, `slots["list.filters"]` | Content list customization |
| `fieldDecorators` | Wrap any field (e.g. an "AI suggest" button, comments) |
| `pages` | Custom admin routes |
| `commands` | Command palette entries |

## Durable Objects and Workflows in plugins

Cloudflare requires Durable Object and Workflow classes to be exported from the Worker's entry module. A plugin package exports its classes, and the `vibe-cms/exports` module re-exports every plugin's classes at build time:

```ts
// src/worker.ts
export * from "vibe-cms/exports";
```

Without the Vite plugin, export them by hand:

```ts
export { SessionDO } from "@acme/search";
```

Either way, the binding itself (and DO migrations) goes in your wrangler or Alchemy config. If the export is missing, Cloudflare rejects the deploy.

### Deferred: one shared Durable Object class

An alternative is a single `VibeDurableObject` that dispatches to plugin handlers by ID prefix, so users add one export and one binding total. It costs isolation between plugins, a shared storage and migration history, and typed RPC. Revisit only if real setups end up with many plugin DOs.
