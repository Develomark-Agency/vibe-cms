# Queries

Reading content from your site's code: the typed query builder, filters and sorting, paging, counts, batching, drafts and the result shape.

Get a client, then query a content type from `config.schemas`:

| Where your code runs | Client |
|---|---|
| The site's own Worker (pages, API routes) | `vibe.client(env)`, in-process, no HTTP. `vibe` is your `createHandler(...)` result. |
| A vibe-cms plugin's server code | `ctx.cms` (`vibe-cms docs server-hooks`) |
| Anywhere else (another app, a browser, a script) | `createClient<typeof config>({ url })` from `vibe-cms/client` (`vibe-cms docs http-client`) |

All three are a `QueryClient<typeof config>` with the same API, so query code can take the client as a parameter:

```ts
// examples/schemas/src/queries.ts
// Query code takes a client, so it runs the same in-process (`vibe.client(env)` in the Worker)
// and over HTTP (`createClient({ url })`).
type Cms<C> = QueryClient<C>;

const { event } = fields.schemas;

export async function upcomingEvents(cms: Cms<typeof fields>) {
  return cms.query(event).findMany({
    where: and(
      gte(event.startsAt, new Date()),
      inArray(event.status, ["open", "full"]),
      not(eq(event.online, true))
    ),
    orderBy: [asc(event.startsAt)],
    limit: 20,
    offset: 0
  });
}
```

Results are typed from the schema, including `with` expansions and the `locale` option.

## Methods

| Method | Returns |
|---|---|
| `findMany({ where, orderBy, limit, offset, locale, with })` | An array. `limit` defaults to 100, at most 1000. Default order: most recently updated first. |
| `findFirst({ … })` | The first match or `null` |
| `findById(id, { locale, with })` | The document or `null` |
| `count({ where, locale })` | A number |

Queries are lazy: they run when awaited, or together in `cms.batch([...])`.

## Filters and sorting

Import operators from `vibe-cms/query`. Columns come from the collection: `event.slug`, nested `event.venue.name`, and `event.id`.

```ts
// examples/schemas/src/queries.ts
export async function filters(cms: Cms<typeof fields>) {
  return cms.query(event).findMany({
    where: or(
      has(event.tags, "workshop"),
      like(event.title, "%summit%"),
      eq(event.venue.name, "Town Hall"),
      search("accessibility")
    ),
    orderBy: [desc(meta.publishedAt)]
  });
}
```

| Operator | Matches |
|---|---|
| `eq`, `ne`, `gt`, `gte`, `lt`, `lte` | Comparisons; values are typed by the column. Date columns take ISO strings or `Date`. |
| `inArray(col, values)`, `notInArray(col, values)` | One of the values / none of them |
| `like(col, pattern)` | SQL `LIKE` with `%` wildcards, case-insensitive for ASCII |
| `has(col, value)` | An array field contains the value (tags, arrays of references) |
| `isNull(col)`, `isNotNull(col)` | Missing / present |
| `and(...)`, `or(...)`, `not(cond)` | Combine. `and`/`or` skip `undefined` and `false`, so `and(cond, input && eq(...))` works. |
| `search(text)` | The text anywhere in the document's JSON (a `LIKE` over all of it, keys included) |

`orderBy` takes `asc(col)` / `desc(col)`, several for tie-breaks. `meta.updatedAt`, `meta.createdAt` and `meta.publishedAt` sort by document metadata. Mark fields you filter or sort on often with `indexed: true` (`vibe-cms docs schemas`).

## Results

Every document comes back with its fields, `id`, and `$meta`:

```ts
// examples/schemas/src/queries.ts
export async function eventPage(cms: Cms<typeof fields>, slug: string) {
  const found = await cms.query(event).findFirst({ where: eq(event.slug, slug) });
  if(!found) return null;
  // Every result has its `id` and `$meta`: locale, createdAt, updatedAt, publishedAt, status.
  return { ...found, lastChanged: found.$meta.updatedAt };
}
```

Published reads fail with `Conflict` if a stored value has the wrong type for its field, naming the document and field (`vibe-cms docs schema-changes`). `$meta.status` is `"draft"` (never published), `"published"` or `"changed"` (published, with newer draft edits). Media fields come back resolved with URLs (`vibe-cms docs media`), references as IDs unless expanded with `with` (`vibe-cms docs references`). `content.read` plugin hooks can reshape results on the way out.

## Batching

```ts
// examples/schemas/src/queries.ts
export async function counts(cms: Cms<typeof fields>) {
  // One round trip for several queries.
  const [open, total] = await cms.batch([
    cms.query(event).count({ where: eq(event.status, "open") }),
    cms.query(event).count()
  ]);
  return { open, total };
}
```

Over HTTP a batch is one request (up to 50 queries).

## Drafts

Queries read published content by default. `{ drafts: true }` reads the working copies instead, including never-published documents:

```ts
// examples/schemas/src/queries.ts
// Working copies instead of published content. Needs a trusted client: in-process, or HTTP with a token.
export async function drafts(cms: Cms<typeof fields>) {
  return cms.query(event, { drafts: true }).findMany({ orderBy: [desc(meta.updatedAt)] });
}
```

The in-process clients (`vibe.client(env)`, `ctx.cms`) are trusted and may read drafts. Over HTTP, drafts need a site session token with read permission for that type; published reads are public. Draft results may be invalid (drafts save with validation issues), so treat their fields defensively.

## Locales

Pass `locale` to read a translation, falling back per document to the default locale: `vibe-cms docs localization`.

## Writing

The query client only reads. Documents are written through actions: the editor, the CLI (`vibe-cms docs cli`), `POST /_vibe/api/actions/documents.create` and friends, MCP (`vibe-cms docs agents`), or the typed action client:

```ts
import { createThrowingActionClient, httpCaller, type CoreActions } from "vibe-cms/actions";

const actions = createThrowingActionClient<CoreActions>(httpCaller({ url: "https://site.example", token }));
const doc = await actions.documents.create({ type: "post", data: { title: "Hello" }, publish: true });
```

Every action needs a site session with the right permissions (`vibe-cms docs permissions`).
