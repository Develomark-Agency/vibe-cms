# Astro example

<span style="white-space: nowrap">Vibe CMS</span> in an Astro site on Cloudflare, with the official `@astrojs/cloudflare` adapter and a hand-written `wrangler.jsonc`. Pages read content in-process with `vibe.client(env)`.

| File | What |
|---|---|
| `vibe-cms.config.ts` | One `post` content type |
| `src/cms.ts` | `createHandler`: the CMS and the bindings it gets |
| `src/worker.ts` | The Worker entry: wraps the adapter's `handle()` with `vibe({ fetch })` |
| `src/content.ts` | `vibe.client(env)` for pages |
| `src/pages/` | A post list and a post page |
| `astro.config.ts` | The adapter, and `vibe()` in `vite.plugins` |
| `wrangler.jsonc` | `main: src/worker.ts`, D1, R2, the assets binding and a cron trigger |

```sh
bun install
bun run dev        # http://localhost:1342, editor at http://localhost:1342/_vibe/admin/
bun run build      # dist/client (with dist/client/_vibe/admin) and dist/server
```

Local D1 and R2 live in `.wrangler/`. See `vibe-cms docs astro`.
