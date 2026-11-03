# CLI

The `vibe-cms` command: these guides, a local panel, building the editor, and every CMS action against a running site.

Run it with `bunx vibe-cms` (or `npx vibe-cms`) in a project that depends on vibe-cms. `--help` works on every command.

| Command | What |
|---|---|
| `vibe-cms docs [topic]` | Print a guide. `vibe-cms docs topics` lists them, `vibe-cms docs search <words>` finds lines across them. |
| `vibe-cms admin [--site <url>] [--port 5173]` | A local panel for development sites, kept in the browser. `--name`, `--accent` and `--icon` white-label it. |
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

Output is the action's result as JSON on stdout, so it pipes into `jq`. Failures print the error tag, message and details on stderr and exit 1 (tags: `vibe-cms docs agents`).

## Signing in

Against a development site, the CLI asks for a developer session by itself. Deployed sites need a site session token in `--token` or `VIBE_TOKEN`; for agents working on deployed sites, use the panel's MCP server instead (`vibe-cms docs agents`).
