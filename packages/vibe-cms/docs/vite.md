# Vite plugin

What `vibe()` from `vibe-cms/vite` does in dev and in builds, its options, and how to use it with a plain Worker or any Vite-based framework.

```ts
import { vibe } from "vibe-cms/vite";

plugins: [vibe(), cloudflare()]
```

## What it does

- **Dev:** serves the editor at `/_vibe/admin/` from a second Vite server in middleware mode, sharing your dev server's port and HMR. Your widgets and admin plugins hot-reload there.
- **Build:** after the client environment writes its output, builds the editor into `<client outDir>/_vibe/admin/` (for `@cloudflare/vite-plugin` and Astro, `dist/client/_vibe/admin/`). The editor bundles the config, so every build picks up schema changes.
- **`.admin` and `.server` files:** files named `*.admin.ts(x)` are replaced with empty stubs everywhere except the editor; `*.server.ts(x)` files are stubbed in browser code. Stubs keep the export names, so `export { X } from "./x.server"` still links. This is how a plugin keeps its editor UI out of the Worker and its server code out of the browser (`vibe-cms docs plugins`).
- **`vibe-cms/exports`:** a virtual module that re-exports the Durable Object and Workflow classes plugins declare with `exports`. Without the plugin, importing it throws.
- **Prefix:** reads `prefix` from the config, so a config with `prefix: "/cms"` serves the editor at `/cms/admin/`.

Generated files (the editor's stylesheet and dependency cache) go to `node_modules/.vibe-cms/`, never your source tree.

## Options

| Option | Default | What |
|---|---|---|
| `config` | `./vibe-cms.config.ts` | Config path, relative to the Vite root |
| `entry` | none | Your Worker entry, for deploy tooling that pins the framework's server entry (Alchemy 2's Astro resource). Imports of that pinned entry are redirected to yours |
| `devCron` | `true` | In dev, runs the Worker's `scheduled` handler every minute, standing in for the production cron trigger, which local dev never fires. Scheduled publishing, trash purging and plugin cron jobs then run while the dev server is up. Pass `false` to turn it off and trigger it yourself at `/cdn-cgi/handler/scheduled` |

## A plain Worker

`@cloudflare/vite-plugin` builds the Worker and, when there is anything client-side, a client output that becomes the Worker's static assets. The editor is built into that client output, so the client build has to run:

- Give the project a `public/` directory with at least one file (`examples/worker` has `public/robots.txt`), or an `index.html`.
- Without either, `vite build` builds only the Worker and you get no `dist/client/_vibe/admin/`.

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

`wrangler.jsonc` needs an `assets` block with a `binding` (the CMS serves the editor's deep links through it); the Cloudflare plugin fills in the directory when it builds.

```sh
bunx vite dev     # editor at /_vibe/admin/
bunx vite build   # dist/client/_vibe/admin/ and dist/<worker name>/
bunx vite preview # the production build, locally
```

In `vite preview` and production, `dev` is false: the dev sign-in is refused and the editor asks you to open it from your panel (`vibe-cms docs deploy`).

## Other Vite frameworks

Any framework that builds with Vite and deploys to Workers takes the plugin in its Vite config: Astro is `vite: { plugins: [vibe()] }` (`vibe-cms docs astro` covers it). There are no framework-specific integrations.

## Type checking

`vite.config.ts` runs in Node while your Worker code uses Workers types. If `tsc` complains about `URL` or `File` types in vibe-cms sources, add `"lib": ["ESNext", "DOM"]` next to `"types": ["@cloudflare/workers-types"]`, as `examples/worker/tsconfig.json` does.
