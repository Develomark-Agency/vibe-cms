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

- **Plugin-derived fields are declared in the schema.** The result of `content.beforeWrite` is validated again, so undeclared fields are dropped. Mark derived fields `readOnly` (shown, not editable) or `hidden`.
- **Typed hooks:** `defineServer<typeof Plugin, typeof config>` types document hooks against the site's content types. The document lives on `output` next to `type` and `valid` (TypeScript can't narrow one parameter from a check on another), so `if(output.type === "post" && output.valid)` gives a typed post. Drafts that fail validation stay plain JSON. Plugins written for any site get `DocumentData` (JSON) throughout.
- **Config strings are checked by `defineConfig`:** collection keys, `title` (a text field), `preview` placeholders (`"/posts/{slug}"`; `{id}` and `{locale}` too), `icon` (the editor's icon set), role rule keys, user role names, `defaultLocale`, and `v.ref()` targets. Query `locale` options take the site's locales.

## Media folders

- **Folders are paths** (`posts/covers`) on each asset, plus a `vibe_folders` table so empty folders persist. A folder exists if it's stored, holds files, or is a parent of either. Uploading or moving a file into a folder stores it.
- **API:** `GET /folders` (every folder with its direct file count), `POST /folders { path }`, `PATCH /folders { from, to }` (rename or move, carrying subfolders and files; refused into itself or onto an existing folder), `DELETE /folders?path=` (empty folders only). Files move with `PATCH /assets/:id { folder }`.
- **Names** are normalised (`" /a//b/ "` → `a/b`); `.`/`..`, control characters and backslashes are refused, at most 12 levels deep.
- **Selecting several:** ⌘/Ctrl-click toggles, Shift-click takes the range in on-screen order, and checkboxes appear on hover. ⌘A selects what's visible, Esc clears, Delete deletes. A floating bar offers Move and Delete, and dragging any selected item moves the whole selection. Things inside a moved folder travel with it rather than moving twice. Bulk delete keeps files used by documents and folders that still hold other files, and reports what it kept.
- **Undo:** moves, renames, new folders and uploads go into a short in-memory history (20 steps, lost on reload). You can undo from the toast's Undo button, ⌘Z, or the toolbar. Deleting files asks first, moves them to the trash, and can be undone the same way; an undone upload skips the trash. Media toasts have their own bottom-centre toaster.
- **Drag images** are a small chip naming what's dragged, built for each drag. The browser's own snapshot of a row inside the page's view-transition layer could capture a large, offset slice of the screen.
- **Text files** (txt, md, csv/tsv, json, yaml, xml, css, js/ts, html; see `src/text-files.ts`) preview in the pane and open in a CodeMirror editor, loaded on demand with one language pack per file. CSV and TSV also get an editable table. SVG shows as an image. `PUT /assets/:id/content` replaces the content (media write, text files up to 1 MB). The asset keeps its ID, and its URL gains `?v=<edits>`, because media is served as immutable. Uploads that arrive as octet-stream get a text type from their extension.
- **The media page** has a tree view and a folders view (subfolders listed, files in a grid), a collapsible preview pane, and drag and drop: files and folders onto a folder or breadcrumb move them, files from the desktop upload into the folder they're dropped on.

## Site settings and appearance

- **Every site has built-in settings:** name, accent colour and icon, edited on the editor's **Site** page and stored in `vibe_meta`. `config.name` is the default; saving the code's name again clears the override. They're in `/.well-known/vibe-cms`, so the panel shows each site's current name, accent and icon, and in `vibe.site(env)` for the site's own pages. Content-like settings (a tagline, a homepage) stay ordinary singleton collections.
- **Permission:** the `siteSettings: true` role rule (or `all`). Writing content doesn't imply it.
- **The accent is one colour.** `styles.css` derives the brand gradient, ring and foreground from `--accent-source` with relative colour syntax; dark text takes over once the accent is lighter than L 0.7, and dark mode lifts dark accents to L 0.68.
- **Panel white-labelling:** `PANEL_NAME`, `PANEL_ACCENT` and `PANEL_ICON` on the hosted panel (`--name`, `--accent`, `--icon` for `vibe-cms admin`). The panel's accent is also the fallback for framed sites without their own.
- **Theme sync:** the panel and the editors it frames keep one light/dark/system choice through the frame protocol: the panel sends `vibe:appearance` (theme and accent) when an editor is ready and on every change, and editors send `vibe:theme` when the user changes it there. Editors also send `vibe:site` after saving site settings, so the panel updates without refetching. A full-page editor keeps its own choice in its origin's storage.

## Pages and blocks

- **`@vibe-cms/blocks`** is its own package, because its Text block uses `@vibe-cms/rich-text`, which itself depends on core. See its README for usage.
- **Definition is separate from rendering.** `defineBlock` gives a block's type, label, icon and fields. Its schema is `v.object({ type: v.literal(…), …fields })`, so a page's `blocks` field is an array of a union told apart by `type`. Pages are therefore ordinary documents, and validation, references, asset resolution, drafts, versions and i18n need no special cases. Rendering happens in the site's components, so the CMS config never imports UI code.
- **Adapters:** `/astro` (any Astro-renderable component; interactive blocks go through a one-line wrapper with a `client:` directive), `/react` (Server Component-safe; client components hydrate), and `/html` (an escaping `html` template). The built-ins are written once, as HTML, and every adapter uses them unless overridden. The component maps require every custom block type at the type level.
- **Core additions:** `format: "path"` for text, `unique: true` for top-level text fields (checked against drafts and published copies, per type and locale), and an `icon` option on any schema (shown in the add-block menu and on block cards). Preview templates keep `/` in placeholder values, so `preview: "{path}"` works.
- **The editor's array-of-union list** (all collections, not just pages) has drag-to-reorder by the grip (with a drop line and a named drag chip), "+" insertion points between cards, a searchable add menu with icons and descriptions, collapse/expand all, and card summaries found through the schema: the first text, else "6 images".

## Actions

- **Every capability is an action** (`src/actions/core.ts`): a name like `documents.publish`, a title and description, a Zod input schema, MCP-style annotations (`readOnly`, `destructive`, `idempotent`), and a `run` that returns a better-result `Result`. Surfaces never call the engine themselves; each only turns its own input into an action's input and its `Result` into its own reply.
- **Errors are tagged values:** `InvalidInput`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `TooLarge`, `UnsupportedType`, `Rejected` and `Unavailable` (`src/actions/errors.ts`), each with `message` and optional `details` (validation `issues`, blocking `references`, a conflicting `updatedAt`). The engine still throws `HttpError`; `attempt()` turns those into tags at the action boundary, so engine methods can move to returning `Result` one at a time. Anything else thrown is a bug and stays a 500.
- **REST** (`src/handler/api.ts`) is a table of `METHOD /path → action`. Input comes from path params, then the body (JSON, multipart for uploads, raw text for text-file edits), then the query string; `fromText` converts query and form strings by the input schema's field types. Error bodies are `{ error, tag, details? }`. Session, `/info`, `/query`, trashed-file bytes and `/media` stay hand-written: they're auth, the public query API, or byte streams, not actions.
- **Any action by name:** `POST /_vibe/api/actions/<name>`, and `GET /_vibe/api/actions` lists them with their input as JSON Schema. The CLI and the editor use this one endpoint.
- **MCP** (`src/handler/mcp.ts`) at `/_vibe/api/mcp`: Streamable HTTP without sessions or streaming, tools only, one tool per action (`documents.publish` → `documents_publish`, since some clients refuse dots). File inputs are `{ name, type?, base64 }` objects. Auth is the site's session token as a bearer; development sites let unauthenticated local agents in as the developer, like the editor's dev sign-in. Agents reach production sites through the panel's `/mcp` (below). Requests with another `Origin` are refused. The protocol handling (`src/actions/mcp.ts`) is shared with the panel.
- **CLI:** `vibe-cms <group> <verb>` for every action (`vibe-cms documents list --type post --site http://localhost:1337`), flags generated from the input schema (kebab-case, `--flag` for booleans, repeated flags for lists, JSON or `@file.json` for objects, a path for files). Without `--token`/`VIBE_TOKEN` it asks a development site for a dev session. Failures print the tag and exit 1.
- **Typed clients:** `createActionClient<CoreActions>(httpCaller({ url, token }))` returns `client.documents.list(input)` resolving to a `Result`; `createThrowingActionClient` rejects instead. The editor's `cms.actions` is the throwing kind over its own `request`, so failures stay `ApiError`s, now with the `tag`. Widgets and admin plugins get it too.
- **Shared types live in the engine:** `DocumentState`, `Asset` and `TrashDetail` are the engine's return types, and the editor imports them, so the editor and the API can't drift apart.
- **Content types are Standard Schema:** every `v` schema and every `config.schemas.<type>` has a non-enumerable `~standard` (Standard Schema plus Standard JSON Schema), so it isn't in the serialized config or its hash. Validation is `validate()`; references and `unique` still need the engine, which has the database. JSON Schema describes the stored shape (input and output are the same, since `validate` returns the stored shape), supports `draft-2020-12` and `draft-07`, and throws for other targets. `schema.get` returns it, so agents know what `data` to send.

## Auth

- **Dev sessions:** with `dev` (default: Vite's `import.meta.env.DEV`), `POST /_vibe/api/session { dev: true }` signs in a local developer with every permission. An embedded editor in dev mode also posts navigation and title messages to any parent, since no code tells it who the panel is.
- **Session lifetime:** site sessions last 12 hours. Embedded editors ask the panel for a fresh code on 401; full-page editors show the sign-in screen.
- **Roles** come from the configured claim and from `permissions.users`; only roles defined in `permissions.roles` count, and a user with none gets 403 at the code endpoint, which the panel shows as "No access".
- `write: { locales }` grants writing (translating) every readable type in those locales.

## Build

- **No framework integrations.** Frameworks built on Vite take the plugin directly (Astro: `vite: { plugins: [vibe()] }`), so there is no `vibe-cms/astro`.

- **The editor is built by a separate Vite instance**, not a Vite environment inside the site's build. Frameworks like Astro own the build orchestration, so the plugin runs `vite.build()` after the client environment writes its bundle, into `<client outDir>/_vibe/admin`. In dev the same configuration runs as a middleware-mode server at `/_vibe/admin`, sharing the site's HTTP server for HMR.
- **Editor stylesheet:** a generated `node_modules/.vibe-cms/admin.css` imports the admin core's styles and adds the project, plus installed packages that depend on vibe-cms, as Tailwind sources. It's a cache file, never in your source tree.
- **Editor dependency cache:** the editor's Vite instance pre-bundles into `node_modules/.vibe-cms/vite` in the site, and the local panel into `node_modules/.vibe-cms/panel-vite`. Vite's default would sit next to the editor's sources, shared by every site and the panel, so one server re-optimizing broke the others' imports (504 "Outdated Optimize Dep").
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
- **Agents connect to the panel, not to each site.** `apps/panel` is an OAuth 2.1 authorization server (discovery via `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamic client registration, authorization code with S256 PKCE, rotating refresh tokens; codes and tokens stored as hashes) and an MCP server at `/mcp`. Its tools are the site actions plus `sites_list`, each taking a `site`. A call gets a site session for the user through the one-time-code handoff, caches it per connection and site, and posts to the site's `/_vibe/api/actions/<name>`; the agent's token never reaches a site.
- **A connection has its own provider sign-in.** Approving an agent sends the user through the identity provider once more (with `login_hint`), and the tokens go to a sessions row owned by the connection. Sharing the browser session's refresh token would break with providers that rotate refresh tokens, and signing out would disconnect agents. The second sign-in must be the same account that approved.
- **Read-only connections** (`content:read`) list and run only actions annotated `readOnly`; the site's permissions still apply on top.
- The consent page is server-rendered HTML in the panel's colours, accepts posts only from the panel's origin, and never redirects to a return address the agent didn't register.
