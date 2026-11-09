# Change sets: per-person drafts and merge on publish

Status: proposed. Not built.

## Problem

A document has one shared draft. When it holds saved but unpublished changes, nothing tells the person publishing what changed, who changed it, or how. Everyone's edits pile onto the same draft, and publishing is all or nothing.

Today:

- Every save appends a row to `vibe_versions` (`id`, `locale`, `ver`, `data`, `author`, `created_at`).
- `vibe_documents.published_ver` points at the live version.
- `documents.update` takes `baseUpdatedAt` and fails with `CONFLICT` if someone saved since. So edits never fork: they're applied one after another, and there's nothing to merge.

## Goal

Publishing works like merging branches in Git:

- Each person has their own branch of a document.
- The publish screen lists every pending branch as plain-language changes: "Alice changed the title from *Spring sale* to *Summer sale*", "Bob changed the description from … to … and the title from … to …".
- It shows which changes go through cleanly and which conflict, and lets the publisher pick per change.
- Publishing some branches leaves the others pending.

## Decisions

- **One branch per person, per document and locale.** Not per session or per task. An agent's branch belongs to the user whose token it uses; the change records that it came through MCP (see [audit log](./audit-log.md)).
- **Diff at the field level, keyed by path** (`title`, `seo.description`, `blocks[<block id>].heading`).
- **Fields that are hard to diff show only that they changed.** Rich text, code, JSON or `mount` widgets with no diff renderer, and any field type without one, show "Alice changed the body". They don't show how. A conflict on such a field is resolved by picking one side whole.

## Model

```
vibe_branches
  id, locale, owner            -- primary key (one branch per person)
  base_ver                     -- the published version the branch started from
  data                         -- the branch's full working copy
  updated_at
```

A branch's changes are computed, not stored: `diff(version base_ver, branch.data)`. Each save still writes a `vibe_versions` row (with `author` and the source, `via`), so history and restore keep working.

The editor opens the person's own branch, creating it from the live version on first edit. A document with no live version yet (never published) is created on the creator's branch. Other people branch from that until the first publish.

Locales work as now: each translation has its own branches.

### Change

```ts
type Change = {
  path: string;            // "title", "blocks[b_8f2].heading"
  kind: "set" | "add" | "remove" | "move";
  before: unknown;         // value at base_ver
  after: unknown;          // value on the branch
  detail: "value" | "changed-only"; // changed-only: rich text etc.
};
```

`detail` comes from the field's diff renderer. Text, numbers, booleans, enums, dates, slugs, references, media and lists of those are `value`. Everything else is `changed-only`.

### Blocks

Block lists diff by block ID, so a move shows as a move ("Moved Testimonials above Hero") and not as a delete plus an add. Blocks need IDs that stay the same across saves; check `vibe-cms/blocks` and add them if they're missing (with a migration that assigns IDs to existing blocks).

## Clean or conflicting

Compare each change against the **current live version**, not the branch's base:

- **Clean:** the live value at `path` still equals `before`, and no other branch selected in this publish changes the same path (or a parent or child of it).
- **Stale:** someone published since the branch started and the live value at `path` changed. Shown as a conflict with "Live is now …".
- **Conflict:** two selected branches change the same path to different values. Two branches that make the same change are not a conflict.

Clean changes from several branches merge into one new live version.

## Publish screen

1. Lists every branch with pending changes: owner, source (editor, MCP, CLI, REST), last edited, and changes as sentences.
2. A checkbox per branch, and per change within it.
3. Conflicts are grouped by field with a choice: one person's value, the live value, or editing it by hand (for `value` fields).
4. Publishing:
   - writes the merged live version;
   - rebases each published branch: changes that went live drop out, and the branch's `base_ver` moves forward;
   - leaves unselected changes pending on their branches.

Rendering per field type:

| Field | Shows |
|---|---|
| Short text, slug | `before` struck through, then `after` |
| Number, boolean, enum, date | before → after |
| Reference | Document titles, not IDs |
| Media | Before and after thumbnails |
| List of simple values | Items added and removed |
| Blocks | Added, removed, moved, and changes inside each block by its fields |
| Rich text, code, JSON, unknown widgets | "changed" |

Later: a visual diff through the existing preview, with changed blocks outlined.

## Other effects

- **Permissions:** a role can be allowed to edit (its own branch) without being allowed to publish. That gives review and approval for agents and junior editors: they propose, someone else publishes. Publishing another person's branch requires the publish permission.
- **Scheduling:** a schedule names the branches (or the merged result) it will publish. If the branches changed since then, the schedule publishes what was approved (store the merged data, like `vibe_schedules.ver` does today).
- **Queries:** draft reads (`preview`, draft tokens) need a defined meaning. Proposal: the reader's own branch, or with no reader, the live version plus every clean change. Decide before building.
- **`documents.*` actions:** `update` writes the caller's branch. New actions: `documents.changes` (pending changes, all branches), `documents.publish` with `branches` / `changes` to pick, `documents.discardBranch`.
- **Hub:** a cross-site "awaiting review" list built from `documents.changes`.

## Phases

1. **Read-only diff:** in the publish dialog, diff the live version against the shared draft, and group changes by the `author` of the versions saved since `published_ver`. Uses existing tables.
2. **Source on saves:** record `via` with each version (shared with the audit log).
3. **Branches:** `vibe_branches`, editor works on the person's branch, merge and conflicts on publish.
4. **Review:** an edit-without-publish role permission and the hub's review list.
5. **Visual diff** in the preview.

## Open questions

- How draft queries read branches (above).
- Whether to show other people's pending changes to a field while you edit it ("Bob also changed this").
- Pruning old versions once branches add more saves.
