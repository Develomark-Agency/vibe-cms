# References

Linking documents with `v.ref()`: what's stored, how integrity is enforced, and expanding references (and reverse references) in queries with `with`.

```ts
// examples/schemas/src/references.ts
  collections: {
    author: {
      schema: v.object({
        name: v.text({ min: 1 })
      })
    },
    category: {
      schema: v.object({
        name: v.text({ min: 1 }),
        parent: v.optional(v.ref("category"))
      })
    },
    post: {
      schema: v.object({
        title: v.text({ min: 1 }),
        // Stores the author's ID. `indexed` speeds up filtering by it.
        author: v.ref("author", { indexed: true }),
        categories: v.array(v.ref("category")),
        // No target type: stores `{ type, id }` and can point at any document.
        featured: v.optional(v.ref())
      })
    }
  }
```

| Schema | Stores | Editor |
|---|---|---|
| `v.ref("author")` | The document ID, `"doc_…"` | A document picker for authors |
| `v.ref()` | `{ type: "author", id: "doc_…" }` | A picker over every content type |
| `v.array(v.ref("category"))` | An array of IDs | A multi-picker |

- `defineConfig` type-checks targets: `v.ref("autor")` is an error naming the unknown type.
- Every write checks that referenced documents exist (`"Referenced document does not exist"`) and are of the right type.
- Deleting a referenced document fails with `CONFLICT`; its `data.references` lists who points at it. Remove the references first, or pass `force: true` to `documents.delete` and leave them dangling (they expand to `null`).
- References point at a document, not a locale: queries resolve them in the query's locale.

## Expanding with `with`

Without `with`, a reference is just its stored ID. `with` replaces it with the referenced document (published, in the query's locale), and nests:

```ts
// examples/schemas/src/queries.ts
export async function postsWithAuthors(cms: Cms<typeof references>) {
  // `with` replaces the stored ID with the referenced document.
  const posts = await cms.query(post).findMany({ with: { author: true, categories: { with: { parent: true } } } });
  return posts.map(p => ({ title: p.title, by: p.author?.name, in: p.categories.map(c => c.parent?.name ?? c.name) }));
}
```

A single reference expands to the document or `null` (missing, or unpublished in a published read); an array of references expands to the documents that exist, in order. The result types follow: `p.author` is typed as an author. Forward expansions take only a nested `with`, and only top-level reference fields expand (not references inside objects or unions).

## Reverse references

On the target side, `with` can name the type that points at it, singular or plural: `posts` (or `post`) on an author finds posts whose top-level `v.ref("author")` fields (single or arrays) point at it. The options take `where`, `orderBy`, `limit` and their own `with`:

```ts
// examples/schemas/src/queries.ts
export async function authorWithPosts(cms: Cms<typeof references>, id: string) {
  // A reverse expansion is named after the type that points here: `posts` finds posts whose `author` is this one.
  return cms.query(author).findById(id, { with: { posts: { orderBy: [desc(meta.publishedAt)], limit: 5 } } });
}
```

## Filtering by reference

A targeted reference is a string column, so `eq(post.author, authorId)` works; add `indexed: true` to fields you filter on often. For an array of references, use `has(post.categories, categoryId)`. See `vibe-cms docs queries`.

## In rich text

Links inside `richText()` can point at documents too (`{ to: { type, id } }`); `renderRichText(doc, { linkTo })` turns them into URLs. See `vibe-cms docs rich-text`.
