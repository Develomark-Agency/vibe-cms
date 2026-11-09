# Activity

Every site logs who did what, when, through which channel, on what, and whether it worked: the editor, agents, the CLI, the API, plugins and cron alike.

So "what did the agent change on Tuesday?" always has an answer.

## What's recorded

The action dispatcher writes the log, so actions don't log themselves: every built-in action and every plugin action is covered.

- **Every change**: creating, editing, publishing, scheduling, deleting and restoring documents; uploads and other media changes; folders; the trash; site settings; backup restores; plugin actions that aren't `readOnly`. Also people (invites, role changes, removals) and roles, which aren't actions.
- **Refused permission checks** (`FORBIDDEN`), for reads too.
- **Sign-ins and sign-outs** on sites that sign people in themselves.
- **Sensitive reads**: backup manifests, table exports and file listings (which hand out download links), and the list of people.
- **Not** ordinary reads, and not input that failed its schema (`BAD_REQUEST`).

For content changes an entry holds the changed fields' names and the version number, never the content: that's in the document's versions. Tokens, passwords, passkeys, invite codes and email bodies are never written.

## Entries

| Field | |
|---|---|
| `at` | When, in milliseconds |
| `actor` | The user's ID, from their session (never from a header), or `system:cron` / `system:hub` |
| `via` | `ui` (the editor), `rest`, `mcp`, `cli`, `plugin` (server code), `cron`, `hub` |
| `client` | The MCP client or browser family, or the CLI's version |
| `onBehalfOf` | Who scheduled a publish that cron ran |
| `action` | `documents.publish`, `plugin:seo.audit`, `roles.save`, `auth.signIn` |
| `targetType`, `targetId`, `locale` | What it acted on |
| `targetLabel` | What it was called then: a document's title, a file's name |
| `ok`, `error` | Whether it worked, and the error code if not |
| `summary` | Changed fields, a version number, roles given |

`via` comes from the `X-Vibe-Via` header (`ui`, `rest`, `cli`, `mcp`) for requests, and defaults to `rest`. The editor and the CLI send it; the MCP route sets `mcp` itself. A header is a claim anyone with a token can make, so it's for attribution, not security: the actor always comes from the session. Your own clients can name themselves with `X-Vibe-Client`, or `httpCaller({ via, client })` (`vibe-cms docs http-client`).

## Reading it

- The editor's **Activity** page is a ledger: time, user, action and result, each row opening to its details. Agents' changes read as the person responsible: "Ada Lovelace via Claude Code". Type to narrow it, or add filters such as `via:agent`, `since:30d`, `action:documents`, `result:refused` and `user:me`; Export CSV saves the rows shown. A document's **History** has an Activity tab next to Versions.
- The `activity.list` action (`activity_list` for agents, `GET /_vibe/api/activity` over REST) takes the same filters: `actor`, `via`, `action` (a name, or a group like `documents`), `targetId`, `since`, `until`, `ok`, and pages with `cursor`.

Owners and roles with `viewActivity: true` see everyone's activity; everyone else sees their own (`vibe-cms docs permissions`).

## Retention

Nothing edits or deletes entries, owners included. The cron trigger prunes entries older than 90 days; change it in the config:

```ts
export default defineConfig({
  activity: { days: 180 },
  // …
});
```
