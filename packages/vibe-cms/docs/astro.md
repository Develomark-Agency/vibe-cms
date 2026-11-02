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
import { eq } from "vibe-cms/query";
import { cms, post } from "../../content.ts";

const entry = await cms.query(post).findFirst({ where: eq(post.slug, Astro.params.slug!) });
if(!entry) return new Response("Not found", { status: 404 });
---
<h1>{entry.title}</h1>
<p>{entry.body}</p>
```

Results are typed from the config: `entry.title` is a `string`. Filters, ordering, references and locales: `vibe-cms docs queries`. For pages built from blocks, see `vibe-cms docs blocks`; for rich text, `vibe-cms docs rich-text`.

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
