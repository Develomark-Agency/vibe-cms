# Audit log

Status: phases 1–3 built (`vibe-cms docs activity`). Phase 4 (sending to the hub) not built.

Where the build differs from this proposal:

- `via` is on the activity entry for each save and publish (with the version number in `summary`), not a new `vibe_versions.via` column: adding a column isn't safe to repeat when two isolates migrate at once.
- The MCP client is named by its user agent: the stateless MCP route doesn't keep what `initialize` said. The panel's MCP calls send `X-Vibe-Via: mcp` and `X-Vibe-Client: vibe-panel`.
- Sign-ins: passkey and identity-provider sign-ins and sign-outs are recorded (`auth.signIn`, `auth.signOut`); hub code exchanges aren't, since the hub renews them every 10 minutes and records its own sign-ins.
- `via: "plugin"` is what trusted in-process engines record; plugins can't yet call actions from server code.
- Open questions, as built: failed validation (`BAD_REQUEST`) isn't recorded; retention defaults to 90 days (`activity: { days }`), with no hard size cap.

## Problem

Content saves record their author (`vibe_versions.author`, `vibe_documents.updated_by`), but nothing else is recorded: publishing, unpublishing, deleting, restoring, media, folders, roles, users, schedules, backups, settings or plugin actions. Nothing records the channel either. With agents editing over MCP, "what did the agent change on Tuesday?" has to have an answer on every site.

## Goal

Every action a user takes, through any channel, is recorded with who, when, through which channel, on what, and whether it worked.

## Where it's recorded

Every channel ends at the action dispatcher: the editor, `POST /_vibe/api/actions/<name>`, the REST routes, MCP, the CLI (which calls the HTTP API) and plugin actions. Each entry point sets an action context; the dispatcher writes the entry after the action runs. Actions don't log themselves, so new core and plugin actions are covered automatically.

```ts
type ActionContext = {
  actor: { user: string; name?: string } | { system: "cron" | "hub" };
  via: "ui" | "rest" | "mcp" | "cli" | "plugin" | "cron" | "hub";
  client?: string;   // MCP client name, CLI version, user agent family
  onBehalfOf?: string; // e.g. the user who scheduled a cron publish
};
```

How `via` is known:

| Channel | Signal |
|---|---|
| Editor | The editor sends a header (`X-Vibe-Via: ui`) |
| CLI | The CLI sends `X-Vibe-Via: cli` and its version |
| MCP | Set by the MCP route; client name from `initialize` |
| REST / actions endpoint | Default when no header is sent |
| Plugin | A plugin calling an action from its server code |
| Cron | Scheduled publishes and other scheduled work |
| Hub | Requests made by the hub (backups, role changes) |

A header is a claim, not proof: anyone with a token can set it. It's for attribution, not security. The **actor** comes from the authenticated session or token, never from a header.

## Entry

```
vibe_activity
  id            -- sortable (time-ordered)
  at
  actor, via, client, on_behalf_of
  action        -- "documents.publish", "plugin:stats.reset"
  target_type, target_id, locale
  ok            -- 1 / 0
  error         -- error code when not ok
  summary       -- short JSON: e.g. changed field paths, a version number, a role name
```

- For content changes, `summary` holds the changed field paths and the version, not the data. The data is in `vibe_versions` (and in branches, see [change sets](./change-sets.md)).
- Secrets and personal data are never written: no tokens, passwords, passkey material, invite codes or email bodies.

## What's recorded

- **All writes:** every action that changes anything, core or plugin.
- **Failed permission checks** (`FORBIDDEN`), since they matter for security.
- **Sign-ins and sign-outs:** fold in what `vibe_signins` records, or link to it.
- **Sensitive reads:** backup downloads, signed media URLs from backup listings, user lists.
- **Not** ordinary reads (document gets, queries, lists). Too much volume for D1, and of little use.

Actions can mark themselves `audit: "read"` to opt a sensitive read in.

## Integrity and retention

- Append-only: no action edits or deletes entries, owners included.
- Pruned by a cron job after a retention period (default 90 days, setting in the config).
- **Hub:** sites attached to a hub send entries to it (batched, through the cron catch-up the hub already uses), so the hub keeps a longer cross-site history and can search it. Standalone sites keep only their own.

## Interface

- **Activity page** in the editor: filter by person, channel, action, document, time.
- **Activity tab** on each document, next to Versions.
- **Action** `activity.list` (same filters, paged), so it's available through MCP, the CLI and REST.
- **Permission:** a role setting `viewActivity`. Owners have it; people can always see their own activity.

## Phases

1. Action context at the entry points and `via` on new versions (shared with change sets phase 2).
2. `vibe_activity`, written by the dispatcher; `activity.list`.
3. Editor pages.
4. Sending to the hub and the cross-site view.

## Open questions

- Whether failed validation (`INVALID_INPUT`) is worth recording or is just noise.
- Default retention, and whether D1 size needs a hard cap.
