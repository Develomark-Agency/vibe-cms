# Build

All build-time wiring happens through a bundler plugin using virtual modules. Nothing is written into your source directory (see the codegen rules in [principles.md](./principles.md)).

## The Vite plugin

Cloudflare's recommended build path is Vite with `@cloudflare/vite-plugin`, which runs the Worker as its own Vite environment. Astro, Vinext, React Router and plain Vite apps all go through it, so the primary integration is a Vite plugin.

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { vibe } from "vibe-cms/vite";

export default defineConfig({
  plugins: [
    vibe({ config: "./vibe-cms.config.ts" }), // default path
    cloudflare(),
  ],
});
```

```ts
// astro.config.ts
import { defineConfig } from "astro/config";
import { vibe } from "vibe-cms/vite"; // no Astro-specific integration needed

export default defineConfig({
  vite: { plugins: [vibe()] },
});
```

The plugin does three things.

### 1. `vibe-cms/exports`: plugin classes as a virtual module

```ts
// src/worker.ts
export * from "vibe-cms/exports";
```

`vibe-cms/exports` is a real file in the package:

```ts
// node_modules/vibe-cms/dist/exports.js (without the plugin)
throw new Error(
  "vibe-cms/exports requires the vibe() Vite plugin. " +
  "Add it to vite.config.ts, or export plugin classes manually.",
);
```

With the plugin, Vite resolves it to a virtual module built from the config:

```ts
// what the plugin serves for "vibe-cms/exports" (never on disk)
export { SessionDO } from "@acme/search";
export { PublishWorkflow } from "@acme/publish-pipeline";
```

Using a specifier the package owns (instead of `virtual:vibe/exports`) means TypeScript resolves it to a real file, so no ambient declarations are needed.

The `export *` line is still written by hand. ES exports are static, and silently rewriting your entry file is more magic than we want. It is one line, once, regardless of plugin count.

### 2. `.admin` / `.server` stubbing per environment

The same convention as React Router's `.server` / `.client` modules:

| File | In the Worker environment | In the admin environment |
|---|---|---|
| `*.admin.ts(x)` | resolved to an empty stub | real module |
| `*.server.ts` | real module | resolved to an empty stub |
| anything else | real module | real module |

So the config can be imported directly by the Worker, even though descriptors point at admin code:

```ts
// widgets/rich-editor.ts (imported by the config, which the Worker imports)
export const RichEditor = defineWidget({
  id: "@acme/rich-text:editor",
  admin: () => import("./rich-editor.admin"), // stubbed in the Worker build
});
```

Published plugin packages can additionally use the `workerd` export condition to ship a server-safe entry:

```jsonc
// @acme/rich-text/package.json
{
  "exports": {
    ".": {
      "workerd": "./dist/index.server.js",
      "default": "./dist/index.js"
    }
  }
}
```

### 3. The site's editor as a third Vite environment

The plugin adds an admin environment that builds the site's editor: a standalone single-page app containing the vibe-cms admin core at this site's version, plus every widget and admin plugin. The panel shows it in an iframe (see [panel-and-auth.md](./panel-and-auth.md)); nothing is shared with the panel at runtime.

- **`vite build`** writes it into the static assets output under `_vibe/admin/`. No separate `vibe build` step.
- **`vite dev`** serves it at `/_vibe/admin` with hot reloading.

```
dist/client/_vibe/admin/
├── index.html
└── assets/…
```

## Without Vite

Plain `wrangler deploy` uses esbuild without user plugins. Two options:

- The plugin is written with **unplugin**, so the same implementation also ships as an esbuild and Rollup/Rolldown plugin, usable from a custom build command.
- Wire it by hand:

```ts
// src/worker.ts
export { SessionDO } from "@acme/search"; // instead of vibe-cms/exports
```

```sh
bunx vibe-cms build-admin --out dist/client/_vibe/admin  # build output, gitignored
```

Vite is the primary path; the manual route is documented, not optimized.

## What ends up where

| Concern | Mechanism | In your repo? |
|---|---|---|
| Content and plugin types | `typeof config`, generics | Nothing |
| Binding contracts | `definePlugin<B>()`, typed `bindings` mapping | Nothing |
| Plugin DO / Workflow classes | `vibe-cms/exports`, resolved at build time | One line you write |
| Server / admin separation | `.admin` / `.server` stubbing per environment | Nothing |
| The site's editor | Third Vite environment | Build output only |
