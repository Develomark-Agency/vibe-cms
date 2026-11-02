# Without Vite

Use vibe-cms in a Worker that `wrangler dev` and `wrangler deploy` build directly: build the editor with `vibe-cms build-admin` and set `dev` yourself.

The Vite plugin is the easier path (`vibe-cms docs vite`). Without it, three things change.

## 1. Build the editor yourself

The editor is a static app that bundles your config. Build it into the directory your `assets` binding serves, under the CMS prefix:

```sh
bunx vibe-cms build-admin --out public/_vibe/admin
```

| Flag | Default | What |
|---|---|---|
| `--out`, `-o` | required | Where to write the editor |
| `--config`, `-c` | `./vibe-cms.config.ts` | The config file |
| `--prefix` | `/_vibe` | Set it if the config changes `prefix` |
| `--root` | current directory | The site root |

Run it again after every config change (content types, collections, widgets, admin plugins): the built editor has the config compiled in. Make it part of your build script, before `wrangler deploy`.

```jsonc
// wrangler.jsonc
{
  "main": "src/worker.ts",
  "assets": { "directory": "public", "binding": "ASSETS", "not_found_handling": "none" },
  "d1_databases": [{ "binding": "DB", "database_name": "my-site", "database_id": "…" }],
  "r2_buckets": [{ "binding": "MEDIA", "bucket_name": "my-site-media" }],
  "triggers": { "crons": ["* * * * *"] }
}
```

## 2. Set `dev` explicitly

`dev` defaults to Vite's `import.meta.env.DEV`, which doesn't exist under wrangler's bundler, so it's always false and the local dev sign-in is refused. Pass it from a variable:

```ts
import { env } from "cloudflare:workers";
import { createHandler } from "vibe-cms/handler";
import config from "../vibe-cms.config.ts";

export const vibe = createHandler(config, {
  dev: env.VIBE_DEV === "true",
  bindings: env => ({ db: env.DB, storage: env.MEDIA })
});
```

Set `VIBE_DEV=true` in `.dev.vars` (local only). Never set it in production: dev mode lets anyone sign in with every permission.

## 3. Export plugin classes by hand

`vibe-cms/exports` needs the Vite plugin. If a plugin declares Durable Object or Workflow classes, re-export them from your entry yourself, using the names in its `exports` (for example `export { ViewCounter } from "./plugins/views/index.ts";`).

Nothing stubs `.admin` and `.server` files either. Widgets and admin plugins are lazy `import()`s in their descriptors, and wrangler's bundler follows those, so their editor code (and React) can end up in the Worker bundle. For sites with widgets or admin plugins, prefer the Vite plugin.

## Run

```sh
bunx vibe-cms build-admin --out public/_vibe/admin
bunx wrangler dev
```

`http://localhost:8787/_vibe/admin/` is the editor. Deploying: `vibe-cms docs deploy`.
