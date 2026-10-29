# Principles

## Cloudflare-native, deploy-tool agnostic

vibe-cms targets one runtime: Cloudflare Workers. It is built directly on D1, R2, Durable Objects, Queues, Workflows and cron triggers, with no storage or platform adapter layer.

- **Database:** D1 (SQLite dialect). D1-specific features like batches and read-replica sessions are fair game.
- **Media:** R2.
- **Background work:** cron triggers, Queues, Durable Objects, Workflows.

How you deploy is not our concern. The CMS is a library mounted inside a Worker you already have (see [handler.md](./handler.md)), so wrangler, Alchemy or anything else works. vibe-cms never provisions infrastructure; it declares typed contracts for the bindings it needs, and you plug in resources you created.

Internally, the engine keeps clean seams between core logic and Cloudflare APIs, but those seams are **not** public adapter interfaces. Internal seams are cheap; public adapters are a long-term promise we are not making.

## Headless content, opinionated admin

"Headless" describes the content API. Consumers can render content with any framework.

The admin UI is not framework-agnostic: it is built in React. Widgets and admin plugins get a framework-neutral escape hatch (`mount`), but React is the first-class path. See [widgets.md](./widgets.md).

## Schemas are data, widgets are UI

A schema describes the shape of data and validates it. A widget displays and edits it. Schemas never grow ad-hoc types just because a widget needs them; instead, packages ship **field presets** (a schema built from primitives, paired with a default widget). See [config-and-schemas.md](./config-and-schemas.md).

Validation always lives in the schema, because writes can arrive through the API, scripts and plugins without ever touching a widget.

## The config is the source of truth for types

Content types, plugin binding contracts and the query API are all inferred from `typeof config`. No type declarations are generated.

## No codegen in your repo

There are three kinds of codegen. Only the last is acceptable:

| Kind | Example | Allowed? |
|---|---|---|
| Generated source files, tracked in the repo | Convex `_generated/` | No |
| Generated type declarations in the repo | React Router `+types/` | No |
| Virtual modules produced at build time, never written to your directory | Vite virtual modules | Yes |

Build output (the admin bundle written to the static assets output folder) is build output, like `dist/`, not source.

## Plugins are trusted code

Plugins are packages you install into your own repo. There is no plugin sandboxing and no capability manifest. Hook inputs and outputs are kept serializable anyway, which leaves the door open later.

## No multi-tenancy

Each client site has its own Worker, D1 database and R2 bucket. Content is never mixed. Multi-site *management* happens through the admin panel, which holds no content (see [panel-and-auth.md](./panel-and-auth.md)).
