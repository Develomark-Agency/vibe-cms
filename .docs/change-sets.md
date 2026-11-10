# Change sets: per-person drafts and merge on publish

Status: built. User-facing docs: `packages/vibe-cms/docs/publishing.md`.

## Problem

A document had one shared draft. When it held saved but unpublished changes, nothing told the person publishing what changed, who changed it, or how. Everyone's edits piled onto the same draft, and publishing was all or nothing.

Before this:

- `vibe_documents` held one `draft` and one `published` copy per document and locale. `updated_by` was the last person to save the draft; nothing else recorded who changed what.
- `vibe_versions` got a row only on publish (and when scheduling one), not on every save.
- `documents.update` took `baseUpdatedAt` and failed with `CONFLICT` if anyone had saved since. Edits never forked, so there was nothing to merge.

## Goal

Publishing works like merging branches in Git:

- Each person has their own branch of a document.
- The publish screen lists every pending branch as plain-language changes: "Alice changed the title from *Spring sale* to *Summer sale*".
- It shows which changes go through cleanly and which conflict, and lets the publisher pick per change.
- Publishing some branches leaves the others pending.

## Decisions

- **One branch per person, per document and locale.** Not per session or per task. When someone edits and saves, that's their version of the document: not published, but a candidate for publishing. An agent's branch belongs to the user whose token it uses; the branch records where the last save came from (`via`: `ui`, `mcp`, `cli`, `rest`; see [audit log](./audit-log.md)).
- **Edits to the same field never overwrite each other.** If Alice and Bob both change the title and save, both versions are kept, one on each branch. They meet only at publish, where the publisher picks.
- **Closing a branch discards it** (`documents.discardChanges`). The branch row is deleted and can't be brought back: saves aren't versions, only publishes are. The person's next edit starts a new branch from live. Discarding the only copy of a never-published document is refused; delete the document instead.
- **Diff at the field level, keyed by path** (`title`, `seo.description`, `blocks[<_key>].heading`).
- **Fields that are hard to diff show only that they changed.** Rich text, code, JSON, any field with a widget, and any other type show "Alice changed the body". A conflict on such a field is resolved by picking one side whole.
- **Hidden and read-only fields aren't anyone's changes.** Plugins derive them (a search text field, say), so diffing them would make every save conflict. Publishing takes them from the newest branch and runs the write hooks again.
- **Draft reads show the reader's own branch, else live, else the newest branch** (for a document never published). This covers `{ drafts: true }` queries, editor lists and the preview, which reads as the editor behind it. "Live plus every clean change" was dropped: nobody needed it, and it depends on which branches count.

## Model

```
vibe_documents
  id, locale, type, published, published_ver, …   -- no draft column
  updated_at, updated_by                         -- last save to any branch, or last publish

vibe_branches
  id, locale, owner            -- primary key (one branch per person)
  owner_name                   -- for display
  base_ver                     -- the published version `base` is; null before the first publish
  base                         -- the copy the branch started from
  data                         -- the branch's full working copy
  via, created_at, updated_at
```

A branch's changes are computed, not stored: `diff(base, data)`. `base` is stored, not looked up by `base_ver`, because before the first publish a branch starts from another person's branch, which isn't a version.

A branch exists only while it has something to publish: saving a copy equal to live deletes it.

- **First edit:** the editor opens the live copy and the first save creates the branch, based on the version the editor read (`baseVer`), so changes published in between aren't taken for the editor's.
- **Never published:** the creator's save is the first branch. Other people start from the newest branch.
- **Unpublishing:** a document with no branches gets one for whoever unpublished it, based on nothing, so there's still something to edit and republish.
- **Locales:** work as before. Each translation has its own branches.

`baseUpdatedAt` now guards only your own branch, so it catches another tab, or an agent working as you, not other people.

### Change

`src/changes/index.ts`, shared by the engine and the editor:

```ts
type Change = {
  path: string;            // "title", "blocks[blk_8f2].heading"
  segments: Segment[];     // the path, with list items as { key }
  kind: "set" | "add" | "remove" | "move";
  before: unknown;         // value at the branch's base (a move: the old position)
  after: unknown;          // value on the branch (a move: the new position)
  detail: "value" | "changed-only";
  label: string[];         // ["Blocks", "Hero", "Heading"]
  field: string;           // the schema type, for rendering
  ref?: string;            // a reference's target type
};
```

### Blocks

Blocks carry a hidden `_key` (in `defineBlock`). The engine assigns one to any block without one, and a new one to a duplicate, on every save and publish. Block lists diff by key, so a move shows as a move (from a longest-increasing-subsequence of positions) and not as a delete plus an add.

Blocks saved before keys existed weren't migrated. Instead, whenever the engine reads a copy, blocks without keys get positional ones (`pos0`, `pos1`…). Every copy of a document gets the same ones, so unchanged blocks match across live and branches, and the next save keeps them.

## Clean or conflicting

Each change is checked against the **current live version**, not the branch's base:

- **Clean:** the live value at `path` still equals `before`, and no other selected branch changes the same path (or a parent or child of it).
- **Live:** live already equals `after` (someone published the same thing). Dropped silently.
- **Stale:** live changed at `path` since the branch started. Needs a choice, like a conflict.
- **Conflict:** two selected branches change overlapping paths differently. Exceptions:
  - Two branches making the same change don't conflict.
  - A move doesn't conflict with edits inside the moved block. A remove does.
  - An edit made on top of another branch's change doesn't conflict with it: Bob editing `seo.description` on a copy started from Alice's new `seo`, before the first publish.

Overlapping conflicts share a `group`, the outermost path involved, and are settled together. Changes are applied outermost first, so an edit inside something another branch adds lands in it. An added or moved block goes after the block before it on its branch that live also has.

Before the first publish there is no live version, so nothing is stale.

## Publish screen

**Two clicks when nothing conflicts:** Publish saves what's unsaved and opens the screen with every clean change ticked. The Publish button takes focus once the changes load, so Enter publishes. Conflicts start as "Decide later" (left pending), so they never block publishing the rest. Choosing a side includes them.

The screen shows what will go live and where each change came from: the person, the source (editor, agent via MCP, CLI, API), and when it was saved. A brand-new document publishes straight away, since all its changes are the creator's.

1. A "needs a choice" card per conflict group: each person's value, what's live, a value typed in (for text fields), or decide later.
2. Every branch with pending changes: a checkbox for the branch and one per change, and the changes as sentences with before and after.
3. The count treats a settled conflict as one change.
4. Publishing:
   - writes the merged live version;
   - rebases each published branch: what went live (or was settled against) drops out, what was left out is replayed onto the new version, and `base_ver` moves forward. A branch with nothing left is deleted;
   - leaves branches that weren't selected as they are. Their changes then show as stale against the new version;
   - leaves a branch saved during the publish untouched (matched on `updated_at`).

Rendering per field type:

| Field | Shows |
|---|---|
| Short text, slug | `before` struck through, then `after` |
| Number, boolean, enum, date | before → after |
| Reference | Document titles, not IDs |
| Media | Before and after thumbnails |
| List of simple values | Items added and removed |
| Blocks | Added, removed, moved, and changes inside each block by its fields |
| Rich text, code, JSON, widgets | "Changed …" |

The editor also says when other people have unpublished changes, and has "Discard my unpublished changes".

## Other effects

- **Actions:** `documents.update` writes the caller's branch and takes `baseVer`. `documents.publish` takes `branches`, `skip` (`{ owner, path }`) and `resolve` (`{ group, use | value }`), and fails with `CONFLICT` and `data.conflicts`. New: `documents.changes`, `documents.discardChanges`. `publish: true` on a save publishes only the caller's branch.
- **Scheduling:** scheduling a publish merges every branch at that moment and stores the result as a version, as before. It fails while anything conflicts. When it runs, branches whose changes are all live are pruned.
- **Search:** indexes live plus every branch, one row per document and locale. A document matches its old title until the new one is published.
- **References, uniqueness and asset usage:** check live and every branch.
- **Trash:** a trashed document keeps its branches and restores them. Older entries, with a `draft`, restore it as the last editor's branch.
- **Backups:** format 2 adds a `branches` table. Format 1 snapshots still restore: their drafts become branches.
- **Migration** (`0003`): drafts that differ from live become their last editor's branch, then the `draft` column, its search triggers and its expression indexes are dropped. Concurrent isolates are safe: a migration that fails because another isolate applied it counts as applied.
- **Permissions:** a role can already edit without publishing. Publishing, including other people's branches, needs the publish permission, as does discarding someone else's branch.

## Review and visual diff

- **Lists:** draft reads carry `$meta.pending` (owner and name, newest first), shown under each row's status. Published reads leave it out, since they're public.
- **`documents.pending`:** every document with unpublished changes that the reader can read, across the site, with `canPublish`.
- **Hub:** the Review page (`/review`) asks each visible site's `documents.pending` with the person's hub token, so each site applies its own permissions. A site that can't answer is listed with why; an older site without the action lists nothing. Hosted panels only: the local panel reaches sites from the browser, which the actions' CORS rules don't allow.
- **Review, not Publish:** the editor's button opens the dialog, which publishes. A new document still says Publish, since it publishes directly. People without publish permission can open it to see what's pending.
- **Field markers:** a bar down a changed field's left edge (amber when anyone else changed it) and a line under it ("You changed this · not saved", "Ana, Carl and 18 others changed this"). The line opens a comparison grouped by value, so 20 people on three titles are three rows. Chosen from the options in `.docs/demos/field-changes.html`. It opens the live value, yours (saved or not) and others', with Use and Undo yours. Your changes are diffed against live in the browser, unsaved edits included; others' come from `documents.changes` and are placed on the form through your copy's block keys. A block only someone else has shows on its list. Never-published documents get no markers, since everything in them is new.
- **Publish dialog:** a Discard per person, and Schedule… for the current selection. `documents.schedule` takes the same `branches`, `skip` and `resolve` as `documents.publish`.
- **Visual diff:** the editor computes `changedBlocks` (your saved copy against live) for the document's preview page and posts it to the preview script, which outlines each block between its `<!--vibe-block:N-->` markers (New, Changed, Moved) and redraws on resize. Only the first block list on a page is outlined, as with focusing a block. Off with "Outline unpublished changes" in the preview's menu, remembered per browser.

## Open questions

- Whether to show other people's pending changes to a field while you edit it ("Bob also changed this").
- Whether saves should become versions, so a discarded branch can be recovered.
- Branches whose owner left the site: who cleans them up.
