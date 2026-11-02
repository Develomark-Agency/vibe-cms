# Schema changes

What happens to stored content when you change a schema, which changes are safe, and how to rename or retype a field on a site that already has content.

vibe-cms doesn't migrate content. Documents are JSON in D1, written under the schema of the time, and validation only runs when a document is written. Reads check one thing: that each stored value still has the right type for its field. Missing values and broken rules (`min`, `format`, …) come back as stored.

When a published value has the wrong type, the query fails with `Conflict` (HTTP 409) and says which document and field:

```
Stored content doesn't match the schema: post doc_0mvv… (en) has the text "https://cdn.example/a.jpg" in "cover",
which expects a media library file ({ asset: "ast_…" }, uploaded with assets.upload). The field's type probably
changed after this was published. Fix the document in the editor, or move the data to a new field: `vibe-cms docs schema-changes`.
```

`details.mismatches` lists up to 20 as `{ type, id, locale, path, expected, found }`. Draft reads (`drafts: true`) don't fail: drafts may hold anything, so they come back as stored. Saving a document with an old value reports it as a validation issue on that field.

## What each change does to existing documents

| Change | Existing documents |
|---|---|
| Add an optional field | Safe. Older documents don't have it (`undefined`), which its type allows. |
| Add a required field | Older documents don't have it, though its type says they do. Reads still work; the editor shows the field as missing, and the document can't be published again until it's filled in. |
| Make an optional field required | Same as adding a required field, for documents without a value. |
| Loosen a rule (`max`, `min`, `accept`, a new enum value) | Safe. |
| Tighten a rule | Reads work; documents that break the new rule can't be published again until fixed. |
| Remove a field | The stored value stays and still comes back in query results (outside the types) until the document is next saved, which drops it. |
| Rename a field | A remove plus an add: the old value is stranded under the old name. |
| Change a field's type (text → `image()`, number → text, …) | Published reads of documents with an old value fail with `Conflict`, naming each document and field (above), until they're fixed or the change is undone. |
| Rename or remove a content type | Its documents stay in the database under the old name, unreachable. |
| Add a content type, collection settings, labels, widgets | Safe. |

## Renaming or retyping a field safely

Don't change a field's type in place: reads of documents with old values fail until every one is fixed. Add the new field next to the old one, copy the data across, then remove the old one:

1. **Add the new field as optional**, keeping the old one. Deploy.
2. **Backfill**: write each document's new value from its old one with a script (below), or by hand in the editor.
3. **Switch your site's code** to the new field, and make it required if it should be.
4. **Remove the old field.** Its stored values disappear as documents are next saved.

For a type change such as a URL text field becoming an `image()`, the backfill step uploads each file first (`assets.upload`, `vibe-cms docs media`) and writes `{ asset: id, alt }` into the new field.

## A backfill script

The action client from `vibe-cms/actions` writes through the same checks as the editor. This one copies an old `summary` into a new `excerpt`:

```ts
// examples/schemas/src/backfill.ts
export async function backfill(actions: ReturnType<typeof createThrowingActionClient<CoreActions>>) {
  const limit = 50;
  // Oldest first: the default order (recently updated first) would shift as the script updates.
  for(let offset = 0; ; offset += limit) {
    const { docs, total } = await actions.documents.list({ type: "post", limit, offset, sort: "$createdAt" });
    for(const { id, $meta, ...data } of docs) {
      if(data.excerpt !== undefined || data.summary === undefined) continue;
      const { summary, ...rest } = data;
      await actions.documents.update({
        type: "post",
        id,
        data: { ...rest, excerpt: summary },
        // Fails with Conflict instead of overwriting an edit made since the list was read.
        baseUpdatedAt: Date.parse($meta.updatedAt),
        // Only republish what was live and unchanged, so unpublished draft edits stay unpublished.
        publish: $meta.status === "published"
      });
    }
    if(offset + limit >= total) break;
  }
}
```

- `documents.list` returns drafts (the working copies), so the script updates drafts and republishes only documents whose draft was the live version.
- `documents.update` replaces the draft's fields, so pass every field you want to keep.
- Each locale is a separate version: pass `locale` to `documents.list` and `documents.update` to backfill translations too (`vibe-cms docs localization`).
- Run it against a development site first. Deployed sites need a session token (`VIBE_TOKEN`); see `vibe-cms docs agents`.

The same steps work from the CLI (`vibe-cms documents list`, `vibe-cms documents update`) or through MCP for small sites.
