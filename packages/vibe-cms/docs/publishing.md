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

In the editor, **Publish** saves what's unsaved and shows the changes as sentences, with who made each one. Clean changes are ticked. Conflicts start out as "Decide later", so publishing everything else is two clicks. `publish: true` on a save publishes only your own changes.

Scheduling a publish merges everyone's changes when you schedule it, and fails while any conflict. Draft reads and the draft preview show the reader's own copy, else the live one (`vibe-cms docs queries`, `vibe-cms docs preview`).
