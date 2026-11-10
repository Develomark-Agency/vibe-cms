# CLI

The `vibe-cms` command: these guides, a local panel, building the editor, and every CMS action against a running site.

Run it with `bunx vibe-cms` (or `npx vibe-cms`) in a project that depends on vibe-cms. `--help` works on every command, and `vibe-cms --help` lists them.

## The TUI

`vibe-cms` with no arguments, at a terminal, opens a full-screen interface that does everything below: pick a site, browse and run its actions (plugins' included) from forms generated from their inputs, read results as coloured JSON, export and import with progress bars, read and search the guides, generate a hub key and find claim links. Every screen shows the command it amounts to, and ⌃Y copies it.

- The site picker lists the Vibe CMS sites running on this machine: it reads the listening ports (`lsof`, or `ss` on Linux, `netstat` on Windows) and asks each for its `/.well-known/vibe-cms`, so sites on any port and CMS path are found, with the folder each was started in. With no `VIBE_SITE` and exactly one site running, the TUI starts on it.
- `VIBE_SITE` picks the starting site; recent sites are remembered in `~/.config/vibe-cms/tui.json` (`$XDG_CONFIG_HOME`, or `$VIBE_CMS_HOME`), addresses only.
- It signs in like the commands do (`VIBE_TOKEN`, a development session, a site login, this project's hub login), but never at the terminal on its own: when a site signs the CLI in itself, ⌃L on the actions list logs in.
- `p` on the home screen starts the local panel (`admin dev`, on port 5183) in the background, against the site you're on; once it's running, `p` again opens it in a browser. The header shows it while it runs; Local panel has its settings, its output, and stop and restart. It stops when you quit, and exits by itself if the TUI is killed.
- The header names the site you're on, from its `/.well-known/vibe-cms`.
- Logging in and out, `admin deploy`, `admin attach` and `build-admin` run as the commands themselves, with the terminal to themselves; the TUI comes back when they finish.
- Keys are in the footer: ↑↓ and Enter to move and open, Esc to go back, ⌃R to run a form from any field, q to quit from the home screen.
- Piped, in CI, or with any argument, `vibe-cms` behaves as it always has.

| Command | What |
|---|---|
| `vibe-cms docs [topic]` | Print a guide. `vibe-cms docs topics` lists them, `vibe-cms docs search <words>` finds lines across them. |
| `vibe-cms admin [dev] [--site <url>] [--port 5183]` | A local panel for development sites, kept in the browser. `--name`, `--accent` and `--icon` white-label it. |
| `vibe-cms admin attach <claim link or site>` | Attach a newly deployed site to your org's panel (below). |
| `vibe-cms admin claim-link <site>` | Print a new site's claim link, if you missed it in its logs (below). |
| `vibe-cms admin deploy` | A wizard that deploys the agency panel to Cloudflare, or redeploys, reconfigures or finds one (below). |
| `vibe-cms build-admin --out <dir>` | Build the editor without the Vite plugin, for plain `wrangler deploy` (`vibe-cms docs wrangler`). `--config`, `--prefix` and `--root` if not the defaults. |
| `vibe-cms export --site <url> [--file x.vibe]` | Save the site's content and media as one `.vibe` file (`vibe-cms docs backups`). |
| `vibe-cms import <file.vibe> --site <url>` | Replace the site's content and media with the file's, after a check and a safety export. `--dry-run` shows what would change. |
| `vibe-cms <group> <action> --site <url>` | Run an action (below). |
| `vibe-cms action <name> --input <json> --site <url>` | Run any action by name, including a plugin's. |
| `vibe-cms actions --site <url>` | List a site's actions, plugins' included, and which agents get as tools. |

## Actions

Every action the editor uses is a command: `vibe-cms <group> <action>`, with flags generated from the action's input. `vibe-cms <group> --help` lists a group's actions and `vibe-cms <group> <action> --help` their flags.

| Group | Actions |
|---|---|
| `schema` | `list`, `get` |
| `documents` | `list`, `get`, `create`, `update`, `delete`, `publish`, `changes`, `discard-changes`, `unpublish`, `references`, `versions`, `version`, `restore-version`, `schedule`, `unschedule` |
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

Actions that plugins add have no commands of their own. Run them by name, with the input as JSON or `@file.json` (`vibe-cms docs plugin-actions`):

```bash
bunx vibe-cms actions --site http://localhost:1337
bunx vibe-cms action stats.longest --input '{"limit":3}' --site http://localhost:1337
```

Output is the action's result as JSON on stdout, so it pipes into `jq`. Failures print the error code, message and data on stderr and exit 1 (codes: `vibe-cms docs agents`).

## Signing in

Against a development site, the CLI asks for a developer session by itself. For deployed sites, log in to your org's hub once per project, by the org's domain (its `VIBE_ORG`):

```sh
bunx vibe-cms login my-agency.com
bunx vibe-cms documents list --type post --site https://ctmoving.com
bunx vibe-cms logout
```

`login` finds the hub through the org's DNS record (or takes the hub's URL directly), opens it in a browser, and keeps the login in the OS keychain, tied to the nearest folder with a `vibe-cms.config.*`. Every command then gets a session from the hub for the site it runs against, as you, so the site decides what you may do. The site has to be in the hub. `logout` revokes the login at the hub and forgets it. A login by org looks the hub up again each time, so it keeps working if the hub moves.

A site without an org signs the CLI in itself. Run a command against it and, at a terminal, the CLI opens the site's editor to sign in and approve it, then carries on. Or log in ahead of time:

```sh
bunx vibe-cms login --site https://client.com
bunx vibe-cms login --site https://client.com --headless   # prints a link; paste the code the page shows
bunx vibe-cms logout --site https://client.com
```

Site logins belong to the site, not the project, and also live in the keychain. `--headless` works for `vibe-cms login <org>` too. A site session token in `--token` or `VIBE_TOKEN` skips all of this, for CI.

## Attaching a site

`vibe-cms admin attach <claim link or site address>` gives a newly deployed site (one without `VIBE_ORG`) to your org's panel: the panel tells the site its org, adds it, and makes you its owner. `vibe-cms admin claim-link <site address>` only prints the link. The walkthrough is in `vibe-cms docs deploy`; the details are here.

```sh
bunx vibe-cms admin attach "https://client.com/_vibe/admin/#claim=…"
bunx vibe-cms admin attach https://client.com --hub my-agency.com   # fetches the link first, logs in to the panel if needed
bunx vibe-cms admin claim-link https://client.com
```

- A claim link ends in `#claim=…`. A site prints it to its logs on its first request, and again whenever `POST /_vibe/api/org/announce` is called (at most once a second; the reply says whether it printed, never what the link is).
- Given a plain address, the CLI asks the site to make its claim token, finds the site's database through your `wrangler` login (a `workers.dev` address names the Worker, a custom domain is looked up among the account's), and reads the token from it. `--worker <name>` says which Worker when the address doesn't tell, and `--binding <name>` which D1 binding the CMS uses when the Worker has several and none is called `DB`. It needs `wrangler` logged in to the account that owns the site.
- `--hub <org or panel address>` logs the project in to the panel first when it has no login. `--template <id|none>` picks the site's starting roles (the panel's default otherwise). `--headless` logs in without a browser.
- You need permission to add sites on the panel. The same thing is the panel's **Add a site** box (paste the link instead of the address), `POST /api/sites/attach` (signed in), `POST /site-attach` (an OAuth access token, as the CLI sends), and the `sites_attach` MCP tool for agents (not offered to read-only connections).
- The site checks the link's token, and that the org's panel is reachable and serves keys, before it accepts the org. A refused claim leaves the link working. The link stops working once it succeeds, or once someone becomes the site's own owner with its setup link. A site that has a `VIBE_ORG` needs no claim: add it by its address.

## Deploying the panel

`bunx vibe-cms admin deploy` is a wizard that sets up, redeploys, reconfigures or finds a panel on Cloudflare. It runs from any directory, uses your `wrangler` login, asks all its questions first, and creates nothing until you confirm the plan. The walkthrough, with what it asks and prints, is in `vibe-cms docs deploy`; the details are here.

- It lists the panels saved on this machine and can search the account's Workers for others. Panels it deploys carry a `VIBE_PANEL` variable, which is how a search finds them. A search recovers their variables and bindings, but not their secrets, which Cloudflare never returns.
- A panel's settings are kept, without secrets, in `~/.config/vibe-cms/panels/<account id>/<worker name>/` (`$XDG_CONFIG_HOME`, or `$VIBE_CMS_HOME` for the whole thing): `hub.json`, and the `wrangler.jsonc` written from it on every run. The panel code is bundled in the `vibe-cms` package, so updating the package and running the wizard again upgrades the panel.
- From the menu you can redeploy, change settings, replace the signing key or the OIDC client secret, or forget a panel on this machine.
- Any OpenID Connect provider works; `apps/panel/README.md` lists the variables and has setups for Clerk and Cloudflare Access.
- The wizard needs a terminal. It reads the account's resources through `wrangler`'s own login; if that login can't read them, it says so and skips the checks.

Running a hub by hand: `bunx vibe-cms hub keygen` prints a new signing key for its `HUB_SIGNING_KEY` secret (`bunx vibe-cms hub keygen | wrangler secret put HUB_SIGNING_KEY`). For agents working on deployed sites, use the hub's MCP server instead (`vibe-cms docs agents`).
