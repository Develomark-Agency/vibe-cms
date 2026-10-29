# vibe-cms

A headless, Cloudflare-native CMS whose content schemas, widgets and plugins are defined in code. It mounts inside the Worker you already have; content lives in D1, media in R2, and every site serves its own editor at `/_vibe/admin`.

Design notes are in [`.docs/`](./.docs/README.md); [`.docs/implementation.md`](./.docs/implementation.md) records how the implementation settles the open questions.

## Workspace

| Package | What |
|---|---|
| [`packages/vibe-cms`](./packages/vibe-cms) | The engine, `v` schema builder, query API, handler, HTTP client, `useContent`, the editor (React, Tailwind, shadcn/ui on Base UI), the panel shell, Vite plugin, Astro integration and CLI |
| [`packages/rich-text`](./packages/rich-text) | `richText()` field preset: a schema built from primitives, a Tiptap widget, and an HTML renderer |
| [`apps/panel`](./apps/panel) | The agency panel: OIDC sign-in, the shared site list, the one-time-code handoff. A Worker with D1 |
| [`examples/blog`](./examples/blog) | An Astro site deployed with Alchemy (0.94), using rich text, images, i18n, a singleton, a `mount` widget and a plugin with a Durable Object |

## Try it

```sh
bun install
bun run dev                      # examples/blog via `alchemy dev` (local D1/R2/DO) → http://localhost:1337
open http://localhost:1337/_vibe/admin/
```

Local development needs no Cloudflare account or identity provider: `alchemy dev` writes `wrangler.jsonc`, the Astro Cloudflare adapter emulates D1, R2 and Durable Objects from it, and the editor signs you in as a local developer.

To see several sites in a panel, run the local panel next to them:

```sh
bunx vibe-cms admin --site http://localhost:1337
```

## Commands

```sh
bun run test        # engine, rich text and panel handoff tests
bun run typecheck   # every package, including the example
bun run lint
```

In `examples/blog`: `bun run build` runs the production build (the same `astro build` that `alchemy deploy` runs; it needs the `wrangler.jsonc` that `alchemy dev` writes) and puts the editor in `dist/client/_vibe/admin/`; `bun run deploy` deploys with Alchemy.

## A site in brief

```ts
// vibe-cms.config.ts
export default defineConfig({
  locales: ["en", "fr"],
  auth: oidc({ issuer: "https://accounts.google.com", clientId: "…" }),
  schemas: {
    post: v.object({
      title: v.text({ min: 1 }),
      slug: v.text({ indexed: true, format: "slug" }),
      author: v.ref("author"),
      cover: v.optional(image({ minWidth: 1200 })),
      body: richText(),
    }),
    author: v.object({ name: v.text() }),
  },
});
```

```ts
// src/worker.ts
export * from "vibe-cms/exports";
export default vibe({ fetch: (req, env, ctx) => app.fetch(req, env, ctx) });
```

```astro
---
const post = await vibe.client(env).query(config.schemas.post).findFirst({
  where: eq(config.schemas.post.slug, Astro.params.slug),
  with: { author: true },
});
---
<h1>{post.title}</h1> <p>{post.author?.name}</p>
```
