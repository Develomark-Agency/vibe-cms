# Implementation notes

How the code settles questions the design docs leave open, and where it deliberately differs from them.

## Storage

- **Table names are prefixed** (`vibe_documents`, `vibe_versions`, …) so the CMS can share a D1 database with the site's own tables.
- **`vibe_documents.published`** holds a copy of the published snapshot next to `published_ver`. Published reads and their expression indexes work on one table without a join; `versions` stays the append-only history.
- **Status** is derived: `draft` (never published), `published` (draft equals published) or `changed`.
- **Engine migrations run on the first request each isolate handles.** Every statement is `CREATE … IF NOT EXISTS`, including the expression indexes for `indexed: true` fields, so concurrent isolates are harmless.
- **The session signing key** is generated on first use and stored in `vibe_meta`, so sites need no secret binding.
- **`updated_at` only ever increases** (by at least 1 ms per write), so `baseUpdatedAt` reliably detects concurrent edits; the editor offers "load theirs" or "overwrite".
- **Bound parameters are chunked** to stay under D1's 100-per-statement limit.

## Content

- **Drafts save even when invalid**; the response carries the issues. Publishing and scheduling require a valid document. Writes through the API with `publish: true` are validated in full.
- **References:** `v.ref("author")` stores the document ID; `v.ref()` (any type) stores `{ type, id }`. The engine checks targets exist on every write, and deleting a referenced document returns 409 unless forced.
- **Reverse `with:`** expansions are named after the referencing type, singular or plural: `with: { posts: { … } }` on an author finds posts whose `v.ref("author")` fields point at it. Typed the same way.
- **Scheduled publishing** snapshots the draft into a version when scheduled, so later edits aren't published by surprise.
- **i18n fallback:** a query in a non-default locale returns each document's translation if it exists, else the default locale's. Deleting from a non-default locale removes only that translation.
- **Public reads:** published content is readable without a token (`POST /_vibe/api/query`, CORS-enabled). Drafts need a session. Pagination is `limit`/`offset`.
- **Unknown object keys are dropped** by validation; `content.beforeWrite` runs after validation, so plugins can still add derived fields (the example adds `readingMinutes`).

## Auth

- **Dev sessions:** with `dev` (default: Vite's `import.meta.env.DEV`), `POST /_vibe/api/session { dev: true }` signs in a local developer with every permission. An embedded editor in dev mode also posts navigation and title messages to any parent, since no code tells it who the panel is.
- **Session lifetime:** site sessions last 12 hours. Embedded editors ask the panel for a fresh code on 401; full-page editors show the sign-in screen.
- **Roles** come from the configured claim and from `permissions.users`; only roles defined in `permissions.roles` count, and a user with none gets 403 at the code endpoint, which the panel shows as "No access".
- `write: { locales }` grants writing (translating) every readable type in those locales.

## Build

- **No framework integrations.** Frameworks built on Vite take the plugin directly (Astro: `vite: { plugins: [vibe()] }`), so there is no `vibe-cms/astro`.

- **The editor is built by a separate Vite instance**, not a Vite environment inside the site's build. Frameworks like Astro own the build orchestration, so the plugin runs `vite.build()` after the client environment writes its bundle, into `<client outDir>/_vibe/admin`. In dev the same configuration runs as a middleware-mode server at `/_vibe/admin`, sharing the site's HTTP server for HMR.
- **Editor stylesheet:** a generated `node_modules/.vibe-cms/admin.css` imports the admin core's styles and adds the project, plus installed packages that depend on vibe-cms, as Tailwind sources. It's a cache file, never in your source tree.
- **Stubs keep export names:** a stubbed `.admin`/`.server` module exports every name the real one does (as `undefined`), so `export { X } from "./x.server"` still links. Loading the config at build time (for `vibe-cms/exports`) stubs both.
- **Plugin classes:** `definePlugin` takes `exports: { from: import.meta.url, names: ["SessionDO"] }`; `vibe-cms/exports` re-exports them.
- **Deep links** into the editor fall back to `/_vibe/admin/index.html` through the assets binding (`env.ASSETS` unless `bindings.assets` is given).

## Astro and Alchemy

- **The example deploys with Alchemy 0.94** (the pre-2 line). Its `Website` resource creates D1, R2 and the Durable Object, writes `wrangler.jsonc` with their bindings, crons and `main: "src/worker.ts"`, runs `astro dev` locally, and builds and uploads on deploy. The official `@astrojs/cloudflare` 14 adapter reads that `wrangler.jsonc` (`configPath`), so dev gets the bindings through `@cloudflare/vite-plugin`, and our entry wraps the adapter's `handle()` in `vibe({...})`.
- Alchemy 0.94's own `Astro` resource targets Astro 5 and `@astrojs/cloudflare` 12, hence `Website`. `spa: false` keeps unknown paths going to the Worker.
- **Alchemy 2 (beta.84)** ships its own Astro adapter and pins the Worker entry; the Vite plugin's `vibe({ entry: "./src/worker.ts" })` redirects that entry to yours. Its CLI also misbehaves when launched by Bun (it reads `npm_execpath`, which package managers set to their own executable, decides it runs under Bun, and loads source files it doesn't publish), and Effect 4.1 breaks it. Switch the example over once it stabilises.

## Panel

- **Shared shell:** the panel UI is `vibe-cms/panel` with two backends. `bunx vibe-cms admin` runs it locally (site list in localStorage, development sites sign in by themselves); `apps/panel` hosts it with an OIDC backend for frontend and D1. The doc's single `apps/panel` package would otherwise have to be shipped inside the CLI.
- **Sign-in:** authorization code with PKCE and nonce; the login is bound to the browser by a short-lived cookie. Refresh tokens renew the ID token before handoffs; Google is asked for offline access.
- **`PANEL_ALLOW`** matches verified email domains or values of the `groups`/`roles` claims. Empty allows everyone the provider signs in.
- **Removing sites:** any panel user can remove a site from the shared list.
- The panel sends `X-Frame-Options: DENY`; it frames sites, and nothing frames it.
