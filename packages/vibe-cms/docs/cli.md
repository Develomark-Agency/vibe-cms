# CLI

The `vibe-cms` command: these guides, a local panel, building the editor, and every CMS action against a running site.

Run it with `bunx vibe-cms` (or `npx vibe-cms`) in a project that depends on vibe-cms. `--help` works on every command.

| Command | What |
|---|---|
| `vibe-cms docs [topic]` | Print a guide. `vibe-cms docs topics` lists them, `vibe-cms docs search <words>` finds lines across them. |
| `vibe-cms admin [dev] [--site <url>] [--port 5173]` | A local panel for development sites, kept in the browser. `--name`, `--accent` and `--icon` white-label it. |
| `vibe-cms admin attach <claim link>` | Attach a newly deployed site to your org's panel (below). |
| `vibe-cms admin deploy` | A wizard that deploys the agency panel to Cloudflare, or redeploys, reconfigures or finds one (below). |
| `vibe-cms build-admin --out <dir>` | Build the editor without the Vite plugin, for plain `wrangler deploy` (`vibe-cms docs wrangler`). `--config`, `--prefix` and `--root` if not the defaults. |
| `vibe-cms export --site <url> [--file x.vibe]` | Save the site's content and media as one `.vibe` file (`vibe-cms docs backups`). |
| `vibe-cms import <file.vibe> --site <url>` | Replace the site's content and media with the file's, after a check and a safety export. `--dry-run` shows what would change. |
| `vibe-cms <group> <action> --site <url>` | Run an action (below). |

## Actions

Every action the editor uses is a command: `vibe-cms <group> <action>`, with flags generated from the action's input. `vibe-cms <group> --help` lists a group's actions and `vibe-cms <group> <action> --help` their flags.

| Group | Actions |
|---|---|
| `schema` | `list`, `get` |
| `documents` | `list`, `get`, `create`, `update`, `delete`, `publish`, `unpublish`, `references`, `versions`, `version`, `restore-version`, `schedule`, `unschedule` |
| `assets` | `list`, `get`, `upload`, `update`, `replace-content`, `delete` |
| `folders` | `list`, `create`, `move`, `delete` |
| `trash` | `list`, `get`, `restore`, `purge`, `empty` |
| `site` | `get`, `update` |

```bash
bunx vibe-cms schema get --type post --site http://localhost:1337
bunx vibe-cms documents create --type post --data '{"title":"Hello","slug":"hello"}' --publish --site http://localhost:1337
bunx vibe-cms documents list --type post --sort -publishedAt --limit 10 --site http://localhost:1337
bunx vibe-cms assets upload --file ./cover.jpg --folder posts --type post --field cover --site http://localhost:1337
bunx vibe-cms documents update --type post --id doc_… --data @post.json --site http://localhost:1337
```

Flags:

- Input fields become kebab-case flags: `baseUpdatedAt` → `--base-updated-at`.
- Booleans are bare flags (`--publish`, `--force`). Lists repeat the flag.
- Objects (`--data`) take JSON, or `@file.json` to read it from a file.
- Files (`--file`) take a path.
- `--site` (or `VIBE_SITE`) is the site's origin; `--prefix` if it isn't `/_vibe`.

Output is the action's result as JSON on stdout, so it pipes into `jq`. Failures print the error code, message and data on stderr and exit 1 (codes: `vibe-cms docs agents`).

## Signing in

Against a development site, the CLI asks for a developer session by itself. For deployed sites, log in to your org's hub once per project, by the org's domain (its `VIBE_ORG`):

```sh
bunx vibe-cms login my-agency.com
bunx vibe-cms documents list --type post --site https://ctmoving.com
bunx vibe-cms logout
```

`login` finds the hub through the org's DNS record (or takes the hub's URL directly), opens it in a browser, and keeps the login in the OS keychain (it needs Bun), tied to the nearest folder with a `vibe-cms.config.*`. Every command then gets a session from the hub for the site it runs against, as you, so the site decides what you may do. The site has to be in the hub. `logout` revokes the login at the hub and forgets it. A login by org looks the hub up again each time, so it keeps working if the hub moves.

A site without an org signs the CLI in itself. Run a command against it and, at a terminal, the CLI opens the site's editor to sign in and approve it, then carries on. Or log in ahead of time:

```sh
bunx vibe-cms login --site https://client.com
bunx vibe-cms login --site https://client.com --headless   # prints a link; paste the code the page shows
bunx vibe-cms logout --site https://client.com
```

Site logins belong to the site, not the project, and also live in the keychain. `--headless` works for `vibe-cms login <org>` too. A site session token in `--token` or `VIBE_TOKEN` skips all of this, for CI.

## Attaching a site

A site deployed without `VIBE_ORG` doesn't belong to an org yet. When the editor first calls it, it logs a one-time claim link beside its setup link (`wrangler tail`, or the dashboard's logs):

```
https://client.com/_vibe/admin/#claim=…
```

Give that link to the panel and the panel tells the site which org it belongs to, then adds it and makes you its owner:

```sh
bunx vibe-cms admin attach "https://client.com/_vibe/admin/#claim=…"
bunx vibe-cms admin attach "…" --hub my-agency.com   # logs in to the panel first, for a project with no login
```

`--template <id|none>` picks the site's starting roles (the panel's default otherwise) and `--headless` logs in without a browser. You need to be allowed to add sites on the panel. The same thing is in the panel's **Add a site** box (paste the link instead of the address), the panel's `POST /api/sites/attach` (signed in) and `POST /site-attach` (an OAuth access token, as the CLI sends), and the `sites_attach` MCP tool for agents (not offered to read-only connections).

The site checks the link's token, and that the org's `_vibe-hub` DNS record points at a hub serving keys, before it accepts the org. A refused claim (a typo, a DNS record not added yet) leaves the link working. The link stops working once it succeeds, or once someone becomes the site's own owner with its setup link. A site that has a `VIBE_ORG` needs no claim: add it by its address.

## Deploying the panel

`bunx vibe-cms admin deploy` runs from any directory, with no project. It uses your `wrangler` login, asks all its questions first, then shows the plan (including the `wrangler` commands that create the database and bucket) and creates nothing until you confirm it at the end.

1. It starts from who `wrangler` is logged in as (offering `wrangler login` if nobody is) and which account to use.
2. It lists the panels it knows on this machine and offers to set up a new one, or to search the account's Workers for one. Panels the wizard deploys carry a `VIBE_PANEL` variable, which is how the search finds them; a search recovers their variables and bindings, but not their secrets, which Cloudflare never returns.
3. A new panel asks for the Worker name, a D1 database, an optional R2 bucket for backups, your org's domain, the OIDC issuer, client ID and allowed sign-ins, and the OIDC client secret. Resources that already exist can be reused; new ones are only named here. A custom hostname is optional: answer no and the panel uses its `workers.dev` address (the org's DNS record points there, and you can add a domain later). If you do give one, it is attached as a Worker custom domain when its zone is on the account; otherwise the wizard deploys to `workers.dev` and says what to add at your DNS host.
4. After you confirm the plan it creates the missing resources, then deploys the panel bundled in the package, uploading the secrets (the client secret, a new signing key, a one-time setup token) with the deploy, then prints the OIDC redirect URI to register, offers to add the org's `_vibe-hub` TXT record when its zone is on the account (an existing record is never overwritten), and prints the setup link that makes you the panel's owner.

Each panel's settings are kept, without secrets, in `~/.config/vibe-cms/panels/<account id>/<worker name>/` (`$XDG_CONFIG_HOME`, or `$VIBE_CMS_HOME` for the whole thing): `hub.json`, and the `wrangler.jsonc` written from it on every run. Run the wizard again to redeploy after upgrading `vibe-cms`, change settings, replace the signing key or the client secret, or forget a panel on this machine. The wizard needs a terminal, and reads the account's resources through `wrangler`'s own login; if that login can't read them, it says so and skips the checks.

Running a hub by hand: `bunx vibe-cms hub keygen` prints a new signing key for its `HUB_SIGNING_KEY` secret (`bunx vibe-cms hub keygen | wrangler secret put HUB_SIGNING_KEY`). For agents working on deployed sites, use the hub's MCP server instead (`vibe-cms docs agents`).
