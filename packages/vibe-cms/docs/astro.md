# Astro

Run vibe-cms inside an Astro site on Cloudflare with the official `@astrojs/cloudflare` adapter: your own Worker entry wraps Astro's, and pages read content in-process.

This follows `examples/astro`. Read `vibe-cms docs getting-started` first for what the config and handler are.

## Install

```sh
bun add vibe-cms astro @astrojs/cloudflare
bun add -d wrangler @cloudflare/workers-types
```

## Files

| File | What |
|---|---|
| `vibe-cms.config.ts` | Content types |
| `src/cms.ts` | `createHandler` with the bindings |
| `src/worker.ts` | The Worker entry: the CMS first, then Astro |
| `src/content.ts` | The in-process client pages import |
| `astro.config.ts` | The adapter and `vibe()` |
| `wrangler.jsonc` | `main`, bindings, cron |

## The Worker entry

Astro's adapter builds whatever `main` in `wrangler.jsonc` points at. Point it at your own entry, which hands non-CMS requests to the adapter's `handle()`:

```ts
// examples/astro/src/worker.ts
import { handle } from "@astrojs/cloudflare/handler";
import { vibe } from "./cms.ts";

// `/_vibe/*` goes to the CMS, everything else to Astro. The cron trigger runs scheduled publishing.
export default vibe({
  fetch: (request, env, ctx) => handle(request as never, env as never, ctx as never)
});
```

If a plugin declares Durable Object classes, add `export * from "vibe-cms/exports";` here.

## Config

```ts
// examples/astro/astro.config.ts
import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import { vibe } from "vibe-cms/vite";

export default defineConfig({
  output: "server",
  // The adapter reads wrangler.jsonc for bindings and builds `main` (src/worker.ts) as the Worker entry.
  // vibe-cms serves uploads from R2, so no Cloudflare Images binding.
  adapter: cloudflare({ configPath: "wrangler.jsonc", imageService: "passthrough" }),
  server: { port: 1342 },
  vite: { plugins: [vibe()] }
});
```

```jsonc
// examples/astro/wrangler.jsonc
{
  "name": "vibe-example-astro",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-08",
  "compatibility_flags": ["nodejs_compat"],
  // Astro's client build, which includes the editor under /_vibe/admin.
  "assets": { "directory": "dist/client", "binding": "ASSETS", "not_found_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "vibe-example-astro", "database_id": "local" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "vibe-example-astro-media" }],
  // Scheduled publishing and trash purging.
  "triggers": { "crons": ["* * * * *"] }
}
```

The adapter also adds a `SESSION` KV binding for Astro sessions to the built `dist/server/wrangler.json`.

## Reading content in pages

`cloudflare:workers` exports `env`, so the client can be created once at module level:

```ts
// examples/astro/src/content.ts
import { env } from "cloudflare:workers";
import { post, vibe } from "./cms.ts";

// In-process reads for pages: no HTTP round trip, published content only.
export const cms = vibe.client(env);
export { post };
```

```astro
---
// examples/astro/src/pages/posts/[slug].astro
import { field } from "vibe-cms/preview";
import { eq } from "vibe-cms/query";
import { cms, post } from "../../content.ts";

const entry = await cms.query(post).findFirst({ where: eq(post.slug, Astro.params.slug!) });
if(!entry) return new Response("Not found", { status: 404 });
---
{/* data-vibe-field: clicking these in the editor's draft preview opens the field. Nothing outside it. */}
<h1 data-vibe-field={field(entry, "title")}>{entry.title}</h1>
<p data-vibe-field={field(entry, "body")}>{entry.body}</p>
```

Results are typed from the config: `entry.title` is a `string`. Filters, ordering, references and locales: `vibe-cms docs queries`. For pages built from blocks, see `vibe-cms docs blocks`; for rich text, `vibe-cms docs rich-text`.

`data-vibe-field={field(entry, "title")}` lets editors click the title in the draft preview to edit it; outside the preview it adds nothing. Blocks and rich text mark themselves. See `vibe-cms docs preview`.

## Routing

Astro's file-based routing still decides which code renders a URL; the CMS decides what content it renders. Most sites combine three kinds of route:

| Route | Serves | Reads |
|---|---|---|
| `src/pages/[...path].astro` | Every editor-managed page, including `/` | The `page` collection, looked up by `path` with `findPage` |
| `src/pages/events/[slug].astro` | One URL per record of a collection | That collection, looked up by its slug |
| A fixed file such as `src/pages/events/index.astro` | Listings and other pages whose structure lives in code | Queries over a collection, and singletons for surrounding text |

Astro matches fixed and parameterised routes before a rest parameter, so the catch-all only receives URLs no other file claims. That lets editors create, rename and remove pages (including the home page, the page whose path is `/`) without a code change, while URLs shaped by data, like `/events/<slug>`, stay with routes written for them.

```astro
---
// src/pages/[...path].astro: every page document, by its path.
import { findPage } from "@vibe-cms/blocks";
import { Blocks } from "@vibe-cms/blocks/astro";
import Layout from "../layouts/Layout.astro";
import { cms, page } from "../content.ts";
import Callout from "../blocks/Callout.astro";

const entry = await findPage(cms, page, Astro.url.pathname);
if(!entry) return new Response(null, { status: 404 });
---
<Layout title={entry.title} description={entry.description}>
  <Blocks blocks={entry.blocks} components={{ callout: Callout }} />
</Layout>
```

The layout is ordinary Astro: it can read singletons (navigation, footer) with `findFirst()` and render them around every route. Blocks rendered by `<Blocks>` can be clicked in the editor's draft preview to edit them; give everything else read from the CMS (a collection route's fields, singleton text in the layout) `data-vibe-field={field(entry, "title")}` marks so it can be picked the same way (`vibe-cms docs preview`). A collection's `preview` setting should match its route (`"{path}"` for pages, `"/events/{slug}"` for events) so the editor's draft preview opens the right URL.

## Types

`src/env.d.ts` declares the bindings and makes `cloudflare:workers`' `env` use them:

```ts
// examples/astro/src/env.d.ts
interface Env {
  DB: D1Database,
  MEDIA: R2Bucket,
  ASSETS: Fetcher
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
```

## Run and build

```sh
bunx astro dev     # http://localhost:1342, editor at /_vibe/admin/
bunx astro build   # dist/client (with _vibe/admin) and dist/server
bunx astro preview # the production build, locally
```

Deploying: `vibe-cms docs deploy`.
