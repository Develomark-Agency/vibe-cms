# <span style="white-space: nowrap">Vibe CMS</span> design notes

A snapshot of the current design decisions for <span style="white-space: nowrap">Vibe CMS</span>: a headless, Cloudflare-native CMS whose content schemas, widgets and plugins are defined in code.

Package subpaths used throughout (`vibe-cms/schema`, `vibe-cms/handler`, `vibe-cms/vite`, …) are working names, not final.

## Documents

| Doc | Covers |
|---|---|
| [principles.md](./principles.md) | Platform stance, trust model, "no codegen in your repo" |
| [config-and-schemas.md](./config-and-schemas.md) | `defineConfig`, the `v` schema builder, field presets, descriptors |
| [widgets.md](./widgets.md) | Widget definition, the `mount` contract, React as the blessed path |
| [plugins.md](./plugins.md) | `definePlugin`, server hooks, admin extension points, binding contracts |
| [handler.md](./handler.md) | `createHandler`, mounting the CMS inside your existing Worker |
| [build.md](./build.md) | The Vite plugin, virtual modules, `.admin` / `.server` stubbing, admin bundle |
| [storage.md](./storage.md) | JSON documents in D1, drafts, versions, i18n, scheduling, media |
| [query-api.md](./query-api.md) | Typed query builder, in-process and HTTP access, `useContent` |
| [panel-and-auth.md](./panel-and-auth.md) | The admin panel, multi-site, OIDC identity, the shared site list |
| [implementation.md](./implementation.md) | How the implementation settles open questions, and where it differs |
| [change-sets.md](./change-sets.md) | Proposed: per-person branches, field diffs and merge on publish |
| [audit-log.md](./audit-log.md) | Proposed: every action recorded with who, when and through which channel |
| [redirects.md](./redirects.md) | Built: redirects in site settings, suggested when slugs change |

## The shape of a project

```
my-client-site/
├── vibe-cms.config.ts       # schemas, widgets, plugins
├── widgets/
│   ├── rich-editor.ts       # widget descriptor (safe to import anywhere)
│   └── rich-editor.admin.tsx# widget implementation (admin bundle only)
├── src/
│   └── worker.ts            # your Worker; the CMS is mounted inside it
├── vite.config.ts           # vibe() + cloudflare() Vite plugins
└── wrangler.jsonc           # or alchemy.run.ts, or anything else
```

```ts
// vibe-cms.config.ts
import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";
import { richText } from "@acme/rich-text";
import { SearchPlugin } from "@acme/search";

export default defineConfig({
  plugins: [SearchPlugin()],
  schemas: {
    post: v.object({
      title: v.text(),
      slug: v.text({ indexed: true }),
      subtitle: v.optional(v.text()),
      body: richText(),
    }),
  },
});
```

```ts
// src/worker.ts
import config from "../vibe-cms.config";
import { createHandler } from "vibe-cms/handler";

export * from "vibe-cms/exports";

const vibe = createHandler(config, {
  bindings: (env: Env) => ({
    db: env.DB,
    storage: env.MEDIA,
    search: { cache: env.SEARCH_KV, sessions: env.SEARCH_SESSIONS },
  }),
});

export default vibe({
  async fetch(req, env, ctx) {
    return new Response("the rest of my site");
  },
});
```
