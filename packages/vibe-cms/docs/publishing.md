# Publishing

Each person edits their own copy of a document. Publishing merges everyone's changes into one new live version and asks only about the ones that clash.

## Your copy

Saving never touches the live site or anyone else's work. The first save makes you a copy of the document, started from the live version, and later saves update it. Agents and scripts save to the copy of the person whose token they use.

- `documents.get` returns your copy as `draft`, the live copy as `published`, and `pending`: everyone with unpublished changes, with where their last save came from (`ui`, `mcp`, `cli`, `rest`).
- A copy that ends up the same as live is removed, since there's nothing to publish.
- Before the first publish, people start from the newest copy, so they build on what's there.
- `documents.discardChanges` throws your copy away. With `owner`, it throws away someone else's, which needs permission to publish.

Pass `updatedAt` back as `baseUpdatedAt` and `baseVer` as `baseVer` when you update. `baseUpdatedAt` catches your own other save in between (another tab, an agent working as you). `baseVer` records which version you started from, so changes published since aren't taken for yours.

## What changed

`documents.changes` lists each person's changes, field by field:

| Field | Meaning |
|---|---|
| `path` | `title`, `seo.description`, `blocks[blk_8f2].heading` |
| `kind` | `set`, or for blocks `add`, `remove` and `move` |
| `before`, `after` | The value the copy started from, and its value now |
| `detail` | `value`, or `changed-only` for rich text, code and custom widgets, which show only that they changed |
| `status` | `clean`; `stale` when it's been published differently since (with `live`); `conflict` when someone else changed it too (with `with`) |
| `group` | Changes settled together when publishing |

Blocks are matched by a key the CMS gives each one (`_key`), so moving a block shows as a move and editing inside one shows as that field. Moving a block and editing inside it at once don't clash; removing it and editing inside it do. Two people making the same change don't clash either. Hidden and read-only fields aren't anyone's changes: plugins derive them again when publishing.

## Publishing

`documents.publish` with no options publishes everyone's changes. It narrows with:

- `branches`: whose changes, by owner.
- `skip`: changes to leave unpublished, as `{ owner, path }`.
- `resolve`: how to settle each conflict or stale change, by its `group`: `{ group, use: "<owner>" }`, `{ group, use: "live" }`, or `{ group, value }`.

While a conflict or stale change is selected and unsettled, it fails with `CONFLICT` and `data.conflicts`. Published copies keep only what was left out, now on top of the new version.

In the editor, **Review** (⌘⇧S) saves what's unsaved and opens the review page (`/content/<type>/<id>/review`), which lists the changes field by field, with the faces of who made each; nothing goes live until you publish from there. People who can't publish see the same list.

- A clean change is ticked, and shown the way its field needs: short values as old → new, long text as the words that changed (with "Show all"), rich text by its text, files as thumbnails, lists as what was added and removed, blocks as added, removed or moved.
- A field people changed differently, or that was published differently since, asks once, on its own row: one version (people who made the same one are grouped, most popular first), **Keep live**, **Write my own** for short text, or **Skip for now**. Once chosen, the row says so ("Using Bob's", "Keeping live", "Skipped") with **Change** to reopen it.
- The page's sidebar lists everyone with changes, where from and when, each with a way to discard what they changed. Schedule and Publish sit in the header, as Save and Review do in the editor. Long lists can be narrowed to what still needs a choice. Clean changes are ticked. Conflicts start out as "Decide later", so publishing everything else is two clicks. Each person's changes can be discarded there too, and **Schedule…** publishes the same selection at a time. `publish: true` on a save publishes only your own changes.

`documents.schedule` takes the same `branches`, `skip` and `resolve`. It merges the selection when you schedule it, so later saves aren't included, and fails while a selected change conflicts.

## Seeing what's pending

- Draft reads (`{ drafts: true }`, the editor's lists) show the reader's own copy, else the live one, and carry `$meta.pending`: who has unpublished changes. Published reads, which are public, don't (`vibe-cms docs queries`).
- `documents.pending` lists every document with unpublished changes that you can read, across the site, with who made them and whether you may publish them. The hub's **Review** page asks every site you can see.
- In the editor, a field you or someone else changed has a bar down its left edge (amber when someone else changed it) and a line under it saying who. The line opens its live value, yours (saved or not) and other people's, grouped by value, with a button to copy any of them into your copy. A collapsed block shows a dot when something inside it changed.
- The draft preview outlines the blocks your saved changes add, change or move, labelled New, Changed or Moved. "Outline unpublished changes" in the preview's menu turns it off (`vibe-cms docs preview`).
