# <span style="white-space: nowrap">Vibe CMS</span>

A headless CMS that runs inside your own Cloudflare Worker. Content types, editor widgets and plugins are TypeScript; content lives in D1, media in R2, and every site serves its own editor at `/_vibe/admin`.

```ts
// vibe-cms.config.ts
import { defineConfig } from "vibe-cms";
import { image } from "vibe-cms/media";
import v from "vibe-cms/schema";

export default defineConfig({
  collections: {
    post: {
      schema: v.object({
        title: v.text({ min: 1 }),
        slug: v.text({ format: "slug", unique: true }),
        cover: v.optional(image()),
        body: v.text({ multiline: true })
      })
    }
  }
});
```

```ts
// src/worker.ts
import { createHandler } from "vibe-cms/handler";
import { eq } from "vibe-cms/query";
import config from "../vibe-cms.config.ts";

const vibe = createHandler(config, { bindings: (env: Env) => ({ db: env.DB, storage: env.MEDIA }) });

export default vibe({
  async fetch(request, env) {
    const post = await vibe.client(env).query(config.schemas.post).findFirst({ where: eq(config.schemas.post.slug, "hello") });
    return Response.json(post);
  }
});
```

## Guides

The guides ship with the package, in [`docs/`](./docs), and print with the CLI:

```bash
bunx vibe-cms docs topics            # every topic, with a one-line summary
bunx vibe-cms docs getting-started   # read one
bunx vibe-cms docs search beforeWrite
```

| Start with | Topics |
|---|---|
| Setting up | `overview`, `getting-started`, `astro`, `vite`, `wrangler`, `deploy` |
| Content types | `config`, `schemas`, `media`, `references`, `localization`, `rich-text`, `blocks`, `schema-changes` |
| Reading content | `queries`, `http-client` |
| Extending | `plugins`, `server-hooks`, `plugin-routes`, `plugin-actions`, `admin-extensions`, `widgets` |
| Access and automation | `permissions`, `agents`, `cli` |

## For AI agents

Read `bunx vibe-cms docs <topic>` before changing a site's `vibe-cms.config.ts`, plugins or CMS setup; the public exports also carry JSDoc pointing at the relevant topic. To edit content rather than code, connect to the site's MCP server: `vibe-cms docs agents`.

## Entry points

| Import | For |
|---|---|
| `vibe-cms` | `defineConfig`, `definePlugin`, `defineWidget`, `Infer`, `InferOutput` |
| `vibe-cms/schema` | The `v` schema builder |
| `vibe-cms/media` | `image()`, `video()`, `file()` |
| `vibe-cms/org` | Org names and hub lookup through DNS (`VIBE_ORG`) |
| `vibe-cms/handler` | `createHandler`: mounts the CMS in your Worker |
| `vibe-cms/query` | Query operators (`eq`, `and`, `desc`, …) |
| `vibe-cms/client` | `createClient`: queries over HTTP |
| `vibe-cms/react` | `useContent` |
| `vibe-cms/actions` | Typed action clients (writes over HTTP) |
| `vibe-cms/server` | `defineServer`: a plugin's server entry |
| `vibe-cms/admin`, `vibe-cms/admin/react`, `vibe-cms/admin/ui` | A plugin's editor entry, React widgets, the editor's components |
| `vibe-cms/vite` | The `vibe()` Vite plugin |
| `vibe-cms/exports` | Durable Object classes declared by plugins |
