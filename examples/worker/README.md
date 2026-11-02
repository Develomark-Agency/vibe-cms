# Worker example

vibe-cms in a plain Cloudflare Worker built with Vite and `@cloudflare/vite-plugin`. The Worker renders HTML strings from in-process queries; there's no framework.

| File | What |
|---|---|
| `vibe-cms.config.ts` | One `post` content type |
| `src/cms.ts` | `createHandler`: the CMS and the bindings it gets |
| `src/worker.ts` | `export default vibe({ fetch })`: `/_vibe/*` goes to the CMS, the rest to your `fetch` |
| `vite.config.ts` | `vibe()` before `cloudflare()` |
| `wrangler.jsonc` | D1, R2, the assets binding and a cron trigger |
| `public/robots.txt` | Any file in `public/` makes Vite build the client output, which is where the editor goes |

```sh
bun install
bun run dev        # http://localhost:1340, editor at http://localhost:1340/_vibe/admin/
bun run build      # dist/client (with dist/client/_vibe/admin) and dist/vibe_example_worker
```

Local D1 and R2 live in `.wrangler/`. See `vibe-cms docs vite`.
