# <span style="white-space: nowrap">Vibe CMS</span>

A headless, Cloudflare-native CMS whose content schemas, widgets and plugins are defined in code. It mounts inside the Worker you already have; content lives in D1, media in R2, and every site serves its own editor at `/_vibe/admin`.

The user guides are in [`packages/vibe-cms/docs/`](./packages/vibe-cms/docs) and print with `bunx vibe-cms docs <topic>` (`bunx vibe-cms docs topics` lists them). Internal design notes are in [`.docs/`](./.docs/README.md); [`.docs/implementation.md`](./.docs/implementation.md) records how the implementation settles the open questions.

## Workspace

| Package | What |
|---|---|
| [`packages/vibe-cms`](./packages/vibe-cms) | The engine, `v` schema builder, query API, handler, HTTP client, `useContent`, the editor (React, Tailwind, shadcn/ui on Base UI), the panel shell, Vite plugin, CLI and the guides. Also `vibe-cms/rich-text` (the `richText()` field: a schema built from primitives, a Tiptap widget and an HTML renderer) and `vibe-cms/blocks` (pages built from blocks, with Astro, React and HTML renderers) |
| [`apps/panel`](./apps/panel) | The agency panel: OIDC sign-in, the shared site list, the one-time-code handoff. A Worker with D1 |
| [`examples/schemas`](./examples/schemas) | Content types, one topic per file, and the queries that read them |
| [`examples/plugins`](./examples/plugins) | One small plugin per feature: hooks, routes, editor pages and slots, widgets, cron, media, Durable Objects |
| [`examples/worker`](./examples/worker), [`examples/astro`](./examples/astro) | Minimal sites: a plain Worker with Vite, and Astro on Cloudflare |
| [`examples/client`](./examples/client) | Reading content from outside the Worker: `createClient`, drafts, raw queries, `useContent` |
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
bun --bun vibe-cms admin --site http://localhost:1337
```

In this repo (and in projects that `bun link` it) the `vibe-cms` bin is the TypeScript source, so run it with `bun --bun`: without `--bun`, Bun follows the bin's `node` shebang and Node can't run the source. The published package is compiled and runs on Node or Bun.

## Agents and scripts

Everything the editor does is an action, and the same actions are exposed over REST, a generic `POST /_vibe/api/actions/<name>` endpoint, MCP and the CLI:

```sh
claude mcp add --transport http blog http://localhost:1337/_vibe/api/mcp   # tools like documents_list, documents_publish
bun --bun vibe-cms documents list --type post --site http://localhost:1337
bun --bun vibe-cms assets upload --file ./cover.jpg --folder posts --site http://localhost:1337
```

Plugins can add actions of their own, run by name (`vibe-cms action <name>`) and, when the plugin opts in, offered to agents as tools (`vibe-cms docs plugin-actions`).

Development sites let local agents and the CLI in as the developer. For deployed sites, connect agents to the panel instead: `https://<panel host>/mcp` covers every site in it, with OAuth sign-in and each user's own permissions (see [`apps/panel`](./apps/panel#ai-agents)).

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
