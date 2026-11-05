# Agents

How AI agents work with vibe-cms: coding agents read these guides, content agents edit through MCP, connecting differently to development and deployed sites.

There are two kinds of agent work, with different tools:

| Work | Agent uses |
|---|---|
| Changing the site's code: schemas, plugins, widgets, framework setup | These guides (`vibe-cms docs`), the types and JSDoc in `node_modules/vibe-cms`, and the CLI to check results |
| Changing content: documents, media, translations, publishing | MCP tools, or the CLI and HTTP actions for scripts |

Content agents can't change schemas: content types live in `vibe-cms.config.ts`, so changing them is a coding task.

## Coding agents

Point the agent at the guides from your project's `AGENTS.md` or `CLAUDE.md`:

```md
This site uses vibe-cms. Before changing vibe-cms.config.ts, plugins or the CMS setup, run
`bunx vibe-cms docs topics` and read the relevant topic with `bunx vibe-cms docs <topic>`.
```

`vibe-cms docs search <words>` finds where something is covered. The guides quote the `examples/` folder in the vibe-cms repository.

## Content agents on a development site

A development site serves MCP at `/_vibe/api/mcp` and lets local agents in as the developer, with every permission and no sign-in:

```bash
claude mcp add --transport http my-site http://localhost:1337/_vibe/api/mcp
```

Use the site's dev server URL and port. Requests with an `Origin` header from another origin are refused, so browser-based clients can't reach it.

## Content agents on deployed sites

Deployed sites don't let anonymous agents in. Sites in an org (`VIBE_ORG`) are reached through their hub; a site without an org signs agents in itself.

### Sites in an org

Connect the agent to the **agency panel**: one MCP server for every site in it, at `https://<panel host>/mcp`.

1. Add `https://<panel host>/mcp` to the agent as a custom connector (Claude, ChatGPT, Cursor, …). The panel's account menu, under **AI agents**, shows the address.
2. The agent opens the panel in a browser; the user approves it (optionally read only) and signs in with the identity provider.
3. The agent calls `sites_list`, then any tool with that site's `id` as `site`.

Each call runs as that user on the site, so the site's role rules apply (`vibe-cms docs permissions`); a `FORBIDDEN` error means the user can't do it. Read-only connections only see read-only tools. Users can disconnect agents under **AI agents**.

The site's own `/_vibe/api/mcp` points agents at the hub.

### Sites without an org

Add the site's own MCP endpoint, `https://<site>/_vibe/api/mcp`, as a custom connector. The site is an OAuth server, the same way the panel is:

1. The agent gets a 401 that points at the site's sign-in, and registers itself.
2. The site's editor opens in a browser: the user signs in (passkey or the site's identity provider) and approves the agent, optionally read only.
3. The agent's calls run as that user, with their roles, worked out on every call. Users see and disconnect agents under **Connected apps** in the editor's account menu.

## Tools

One tool per action, with dots as underscores: `documents.publish` → `documents_publish`. The panel adds `sites_list` and a `site` argument on every tool, and `sites_attach` (a newly deployed site's claim link in, the site added to the panel out; not offered to read-only connections, `vibe-cms docs cli`).

| Group | Tools |
|---|---|
| Schema | `schema_list`, `schema_get` (a content type's fields as JSON Schema: what `data` must look like) |
| Documents | `documents_list`, `documents_get`, `documents_create`, `documents_update`, `documents_delete`, `documents_publish`, `documents_unpublish`, `documents_references`, `documents_versions`, `documents_version`, `documents_restoreVersion`, `documents_schedule`, `documents_unschedule` |
| Media | `assets_list`, `assets_get`, `assets_upload`, `assets_update`, `assets_replaceContent`, `assets_delete`, `folders_list`, `folders_create`, `folders_move`, `folders_delete` |
| Trash | `trash_list`, `trash_get`, `trash_restore`, `trash_purge`, `trash_empty` |
| Site | `site_get`, `site_update` |

How they behave:

- Call `schema_list`, then `schema_get` for a type, before creating or updating its documents.
- Writes save drafts. Drafts save even when invalid and return `issues`; `documents_publish` (or `publish: true`) needs a valid document.
- `documents_update` replaces the draft's fields. Pass the `updatedAt` from `documents_get` as `baseUpdatedAt` to fail with `CONFLICT` rather than overwrite someone's edit.
- Media fields take `{ asset: "<id>" }` plus their per-usage fields (like `alt`): upload with `assets_upload` (file as `{ name, type?, base64 }`) first. See `vibe-cms docs media`.
- References take document IDs (`vibe-cms docs references`); translations take a `locale` (`vibe-cms docs localization`).
- Deleting moves things to the trash; `trash_purge` and `trash_empty` can't be undone.

## Errors

Failures carry a code, a message and sometimes `data`:

| Code | Means |
|---|---|
| `BAD_REQUEST` | Malformed input: missing fields, wrong types, unknown locale |
| `UNAUTHORIZED` | No session, or it expired |
| `FORBIDDEN` | The user's roles don't allow it |
| `NOT_FOUND` | No such document, asset or trash item |
| `CONFLICT` | Someone else's edit (`data.updatedAt`), blocking references (`data.references`), a taken name, or stored content that no longer fits the schema (`data.mismatches`) |
| `UNPROCESSABLE_CONTENT` | Fails validation (`data.issues`), a plugin's veto, or a file the field doesn't accept |
| `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` | The upload's size or type |
| `NOT_IMPLEMENTED` | The site isn't set up for it, e.g. uploads without an R2 binding |

## Scripts

For repeatable changes (imports, backfills), script the same actions over HTTP with the CLI or the typed action client: `vibe-cms docs cli` and `vibe-cms docs schema-changes`.
