# Overview

What Vibe CMS is, how a project using it is laid out, which code runs where, and the URLs it serves. Start here.

<span style="white-space: nowrap">Vibe CMS</span> is a headless CMS that runs inside your own Cloudflare Worker. You define content types, editor widgets and plugins in TypeScript; content is stored as JSON documents in D1 and media in R2; every site serves its own editor at `/_vibe/admin`. Nothing is generated into your repository, and the CMS never provisions Cloudflare resources: you hand it bindings.

## A project

```
my-site/
├── vibe-cms.config.ts     # defineConfig: content types, plugins, locales, permissions
├── src/
│   ├── cms.ts             # createHandler(config, { bindings }) → `vibe`
│   ├── worker.ts          # export default vibe({ fetch: yourApp })
│   └── plugins/…          # your own plugins (optional)
├── vite.config.ts         # vibe() Vite plugin (or astro.config.ts → vite.plugins)
└── wrangler.jsonc         # D1, R2, assets and cron bindings
```

`vibe-cms docs getting-started` walks through adding these to a Worker. `vibe-cms docs astro`, `vibe-cms docs vite` and `vibe-cms docs wrangler` cover each setup.

## Where code runs

The config is imported by both the Worker and the editor (a React app in the browser), so it must stay plain data plus lazy imports.

| File | Runs in | Holds |
|---|---|---|
| `vibe-cms.config.ts` and what it imports | Worker and editor | Schemas, collection settings, plugin and widget descriptors |
| `*.server.ts` | Worker only | Plugin server hooks, Durable Objects, anything using bindings |
| `*.admin.ts(x)` | Editor only | Widget implementations, admin pages and slots (React) |

The `vibe()` Vite plugin swaps `.admin` files for empty stubs outside the editor, and `.server` files for stubs in browser code, so a descriptor can name both without either runtime loading the other's code.

## URLs

Everything lives under the prefix (`/_vibe` unless `prefix` is set in the config). All other requests go to your own `fetch` handler.

| URL | What |
|---|---|
| `/_vibe/admin/` | The editor |
| `/_vibe/api/query` | Public content queries (`POST`, CORS-enabled); drafts need a token |
| `/_vibe/api/actions/<name>` | Any action by name, e.g. `documents.publish` (`GET /_vibe/api/actions` lists them) |
| `/_vibe/api/mcp` | The site's MCP server for agents |
| `/_vibe/plugins/<plugin>/…` | Plugin HTTP routes |
| `/_vibe/media/<asset id>.<ext>` | Uploaded files |
| `/.well-known/vibe-cms` | The site's name, icon and sign-in settings, for the panel |

Plugin pages in the editor live at `/_vibe/admin/p/<plugin>/…`; see `vibe-cms docs plugin-routes`.

## How the pieces fit

A typical site is built from four kinds of content, each with its own tool:

| Content | Tool | Example |
|---|---|---|
| Pages editors compose and give URLs to, the home page (`/`) included | One `page` content type from `pageSchema()`, rendered by a catch-all route | Home, About, Services, Contact |
| Repeated, structured records | A content type per kind of thing, with its own fields | Team members, products, events, testimonials, posts |
| Site-wide values | A `singleton` collection | Navigation, footer, contact details |
| Images, video and files | Media fields pointing into the media library | A hero image, a team member's photo, a PDF brochure |

Blocks connect them: a page is a list of blocks, and a block can show records from a collection ("the three latest events", "these team members") through references. Custom blocks and your own components are how a site gets its own look while editors keep control of what goes where. Plugins add behaviour around all of it. See `vibe-cms docs blocks`, `vibe-cms docs schemas`, `vibe-cms docs media` and `vibe-cms docs plugins`; `vibe-cms docs astro` shows how routes map URLs to each.

## Reading content in your site

`vibe.client(env)` queries content in-process from your Worker; `createClient({ url })` does the same over HTTP from anywhere else. Both return typed results from the config. See `vibe-cms docs queries` and `vibe-cms docs http-client`.

## Topics

Run `vibe-cms docs topics` for the full list. The main ones:

- Content: `vibe-cms docs config`, `vibe-cms docs schemas`, `vibe-cms docs media`, `vibe-cms docs references`, `vibe-cms docs localization`, `vibe-cms docs rich-text`, `vibe-cms docs blocks`, `vibe-cms docs schema-changes`
- Reading: `vibe-cms docs queries`, `vibe-cms docs http-client`
- Extending: `vibe-cms docs plugins`, `vibe-cms docs server-hooks`, `vibe-cms docs plugin-routes`, `vibe-cms docs admin-extensions`, `vibe-cms docs widgets`
- Running: `vibe-cms docs getting-started`, `vibe-cms docs deploy`, `vibe-cms docs permissions`, `vibe-cms docs backups`
- Automation: `vibe-cms docs agents`, `vibe-cms docs cli`

The guides quote the vibe-cms repository's `examples/` folder: `examples/schemas` (content types and queries), `examples/plugins` (one plugin per feature), and `examples/astro`, `examples/worker` and `examples/client` (integration).
