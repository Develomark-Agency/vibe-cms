# Getting started

Add vibe-cms to a Cloudflare Worker: a config file, a handler wrapped around your Worker, the Vite plugin, and the bindings it needs. Ends with the editor running at `/_vibe/admin`.

vibe-cms runs inside your own Worker. It doesn't create Cloudflare resources and it doesn't generate files in your repository: you hand it a D1 database (and optionally an R2 bucket), and it creates its tables on the first request.

The steps below follow `examples/worker` in the vibe-cms repository. For Astro, read this page, then `vibe-cms docs astro`. Without Vite, see `vibe-cms docs wrangler`.

## 1. Install

```sh
bun add vibe-cms
bun add -d vite @cloudflare/vite-plugin wrangler @cloudflare/workers-types
```

The `vibe-cms` CLI (`vibe-cms docs`, `vibe-cms admin`, actions against a site) runs on Bun.

## 2. Write the config

`vibe-cms.config.ts` at the project root declares the content types. The Vite plugin looks for it there.

```ts
// examples/worker/vibe-cms.config.ts
import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

export default defineConfig({
  collections: {
    post: { title: "title", preview: "/posts/{slug}" }
  },
  schemas: {
    post: v.object({
      title: v.text({ min: 1 }),
      slug: v.text({ format: "slug", indexed: true, unique: true }),
      body: v.text({ multiline: true })
    })
  }
});
```

The config is plain data, so it's safe to import from the Worker, the editor and other apps. Fields and options: `vibe-cms docs schemas` and `vibe-cms docs config`.

## 3. Create the handler

`createHandler` takes the config and a `bindings` function that maps your Worker's `env` to the resources the CMS uses. The keys on the left are fixed; the env names are yours.

```ts
// examples/worker/src/cms.ts
import { createHandler } from "vibe-cms/handler";
import config from "../vibe-cms.config.ts";

// Hands the CMS its resources. The names on the left are fixed; the env bindings are yours (see wrangler.jsonc).
export const vibe = createHandler(config, {
  bindings: (env: Env) => ({ db: env.DB, storage: env.MEDIA })
});

export const { post } = config.schemas;
```

| Binding | Required | Used for |
|---|---|---|
| `db` | yes | Documents, versions, the media library index, sessions |
| `storage` | for uploads | R2 bucket for media files |
| `assets` | no | The static assets binding that serves the editor's files. Defaults to `env.ASSETS` |
| *plugin name* | when a plugin declares bindings | Whatever that plugin's `definePlugin<{ … }>()` asks for (`vibe-cms docs plugins`) |

A missing `db`, or a plugin binding that is `undefined` at runtime, fails the first request with an error naming it.

`dev` defaults to Vite's `import.meta.env.DEV`: true under `vite dev`, false in builds. In dev mode the editor signs you in as a local developer without an identity provider, and local agents and the CLI get in the same way.

## 4. Wrap your Worker

Calling the handler with your Worker's handlers returns a Worker export. Requests under `/_vibe` (and `/.well-known/vibe-cms`) go to the CMS; everything else goes to your `fetch`. The `scheduled` handler runs scheduled publishing, trash purging and plugin cron jobs, then yours; `queue` runs a plugin's consumer, or yours.

```ts
// examples/worker/src/worker.ts
import { eq } from "vibe-cms/query";
import { post, vibe } from "./cms.ts";

// `/_vibe/*` goes to the CMS; everything else to this `fetch`. The cron trigger runs scheduled publishing.
export default vibe({
  async fetch(request, env) {
    const cms = vibe.client(env);
    const { pathname } = new URL(request.url);

    if(pathname === "/") {
      const posts = await cms.query(post).findMany({ limit: 20 });
```

`vibe.client(env)` reads published content in-process, typed by the config (`vibe-cms docs queries`). If you route requests yourself (Hono, itty-router), use `vibe.match(request)` and `vibe.handle(request, env, ctx)` instead of wrapping, and call `vibe.scheduled` from your `scheduled` handler.

If a plugin declares Durable Object or Workflow classes, re-export them from the entry: `export * from "vibe-cms/exports";` (it needs the Vite plugin).

## 5. Add the Vite plugin

```ts
// examples/worker/vite.config.ts
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { vibe } from "vibe-cms/vite";

export default defineConfig({
  server: { port: 1340 },
  // vibe() serves the editor at /_vibe/admin in dev and builds it into the client output.
  plugins: [vibe(), cloudflare()]
});
```

`vite build` only builds the client output (where the editor goes) when there's something client-side to build. A Worker with no `index.html` or `public/` files has none, so add a `public/` directory with at least one file, such as `robots.txt`. See `vibe-cms docs vite`.

## 6. Declare the bindings

```jsonc
// examples/worker/wrangler.jsonc
{
  "name": "vibe-example-worker",
  "main": "src/worker.ts",
  "compatibility_date": "2026-07-08",
  "compatibility_flags": ["nodejs_compat"],
  // The editor is static files under /_vibe/admin; the CMS serves its deep links through this binding.
  "assets": { "binding": "ASSETS", "not_found_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "vibe-example-worker", "database_id": "local" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "vibe-example-worker-media" }],
  // Scheduled publishing and trash purging.
  "triggers": { "crons": ["* * * * *"] }
}
```

Locally, D1 and R2 are emulated in `.wrangler/`, so no Cloudflare account is needed. Type `env` to match (the example's `src/env.d.ts` declares `DB`, `MEDIA` and `ASSETS`).

## 7. Run it

```sh
bunx vite dev
```

- `http://localhost:1340/_vibe/admin/` is the editor, signed in as the local developer.
- Create and publish a post there, or from the CLI:

```sh
bunx vibe-cms documents create --type post --data '{"title":"Hello","slug":"hello","body":"First post."}' --publish --site http://localhost:1340
```

- `http://localhost:1340/posts/hello` renders it.

## Next

- Content types: `vibe-cms docs schemas`, `vibe-cms docs media`, `vibe-cms docs references`
- Reading content: `vibe-cms docs queries`, `vibe-cms docs http-client`
- Extending the CMS: `vibe-cms docs plugins`
- Going live: `vibe-cms docs deploy`
- Agents and scripts: `vibe-cms docs agents`, `vibe-cms docs cli`
