# Plugins example

One small plugin per feature, all registered in [`vibe-cms.config.ts`](./vibe-cms.config.ts) on a single `post` type, so `bun run typecheck` checks them against a real config. It isn't a site: copy a plugin folder into yours, add it to your config's `plugins`, and supply its bindings in `createHandler` (as [`src/cms.ts`](./src/cms.ts) does).

| Folder | Shows | Guide |
|---|---|---|
| [`src/slugs`](./src/slugs) | Filling a field before validation, deriving one after | `vibe-cms docs server-hooks` |
| [`src/rules`](./src/rules) | Refusing a publish and a delete, reading drafts | `vibe-cms docs server-hooks` |
| [`src/webhook`](./src/webhook) | `content.afterWrite`, options, a binding contract | `vibe-cms docs plugins` |
| [`src/stats`](./src/stats) | HTTP routes, editor pages, a nav link, calling routes | `vibe-cms docs plugin-routes` |
| [`src/editor`](./src/editor) | Document sidebar and actions, list columns, commands, field decorators | `vibe-cms docs admin-extensions` |
| [`src/widgets`](./src/widgets) | A React widget and a framework-neutral one | `vibe-cms docs widgets` |
| [`src/scheduled`](./src/scheduled) | `cron` and `queues` | `vibe-cms docs server-hooks` |
| [`src/media`](./src/media) | `media.beforeUpload`, `media.analyze` | `vibe-cms docs server-hooks` |
| [`src/counter`](./src/counter) | A Durable Object exported through `vibe-cms/exports` | `vibe-cms docs plugins` |

Each plugin folder has an `index.ts` (the descriptor, imported by the config), a `plugin.server.ts` (Worker only) and/or a `plugin.admin.tsx` (editor only).
