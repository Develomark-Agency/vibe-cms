# Schemas

The `v` schema builder: every field type and option, what's required, how documents are validated, and the TypeScript types you get.

A content type is a `v.object({…})` in the config's `schemas`. The same schema drives storage validation, the editor's form, the API's JSON Schema (`schema.get`) and the types of query results. Import the builder as `v`:

```ts
import v from "vibe-cms/schema";
```

## Modelling content

A content type describes one kind of thing, and each document is one of them. The more of a site's content lives in typed fields, the more the CMS can do with it: queries filter and sort by fields, references link records together, the editor shows a form shaped to the data, and the same record can appear in many places.

- **Pages** are one content type, usually `page` from `pageSchema()` (`vibe-cms docs blocks`). Each page document is a URL on the site, the home page among them.
- **Collections of records** get a content type each: `teamMember`, `event`, `product`, `testimonial`, `location`. Give them the fields the site displays (a name, a role, a photo, a date, a price) rather than one block of text, and they can be listed, filtered, linked to and reused.
- **Site-wide content** that exists once (navigation, footer, contact details, social links) is a content type with `singleton: true` in its collection settings (`vibe-cms docs config`).
- **Links between them** are references: a page block that shows chosen testimonials holds `v.ref("testimonial")` values, an event references its venue, a post its author (`vibe-cms docs references`).

For example, a team section on the About page is a `teamMember` content type (name, role, `image()` photo, bio, sort order) plus a block that either lists every member or references a chosen few. Editors add a new hire once, and every page showing the team picks them up.

## Every field type

```ts
// examples/schemas/src/fields.ts
// Every field type on one content type. Fields are required unless wrapped in `v.optional`.
export const event = v.object({
  title: v.text({ min: 1, max: 120 }),
  slug: v.text({ format: "slug", unique: true, indexed: true }),
  summary: v.optional(v.text({ multiline: true, max: 280, description: "Shown in listings" })),
  contact: v.optional(v.text({ format: "email" })),
  website: v.optional(v.text({ format: "url" })),
  code: v.optional(v.text({ pattern: "^[A-Z]{3}-\\d{3}$", label: "Event code" })),

  startsAt: v.date({ time: true, indexed: true }),
  endsOn: v.optional(v.date()),
  capacity: v.number({ integer: true, min: 1 }),
  price: v.optional(v.number({ min: 0, step: 0.01 })),
  online: v.boolean(),
  status: v.enum(["planned", "open", "full", "cancelled"], { labels: { open: "Open for sign-ups" }, indexed: true }),

  tags: v.array(v.text(), { max: 10 }),
  venue: v.optional(v.object({
    name: v.text(),
    address: v.text({ multiline: true })
  })),
  sessions: v.array(v.object({
    title: v.text(),
    minutes: v.number({ integer: true })
  }, { label: "Session" }), { label: "Programme" }),

  // Kept by code (a plugin or an import), not by editors.
  externalId: v.optional(v.text({ readOnly: true })),
  importedAt: v.optional(v.date({ time: true, hidden: true }))
});
```

| Builder | Stores | Options |
|---|---|---|
| `v.text()` | string | `min`, `max` (length), `format` (`"email"`, `"url"`, `"slug"`, `"path"`), `pattern` (regex source), `multiline`, `indexed`, `unique` |
| `v.number()` | number | `min`, `max`, `integer`, `step`, `indexed` |
| `v.boolean()` | boolean | `indexed` |
| `v.date()` | ISO 8601 string | `time` (date and time instead of a date), `indexed` |
| `v.enum([...])` | one of the strings | `labels` (display label per value), `indexed` |
| `v.literal(value)` | exactly that value | Mostly for telling union members apart |
| `v.optional(schema)` | the inner value, or nothing | |
| `v.array(item)` | array | `min`, `max` (items) |
| `v.object({...})` | object | |
| `v.union([...])` | one of the options | See `vibe-cms docs references` for refs, and Unions below |
| `v.ref("type")` / `v.ref()` | document ID / `{ type, id }` | `indexed`. See `vibe-cms docs references` |
| `v.asset()`, `image()`, `video()`, `file()` | `{ asset, …per-usage fields }` | See `vibe-cms docs media` |

Every builder also takes `label` and `description` (shown in the editor), `icon` (shown next to the label, e.g. in a block menu), `widget` (a custom editor, see `vibe-cms docs widgets`), `readOnly` (shown, not editable: for values code maintains) and `hidden` (not shown at all).

Presets from other packages are built from these: `richText()` (`vibe-cms docs rich-text`) and `pageSchema()` / `blocks()` (`vibe-cms docs blocks`).

### Formats

| `format` | Accepts |
|---|---|
| `"email"` | An email address |
| `"url"` | An `http(s)://` URL, or a root-relative path like `/contact` |
| `"slug"` | Lowercase letters, digits and hyphens |
| `"path"` | A site path like `/about/team`: leading slash, lowercase, no trailing slash; `/` alone is the home page |

### `indexed` and `unique`

- `indexed: true` adds a SQLite expression index for that field, so filtering and sorting on it stays fast. Any field can be filtered without it.
- `unique: true` (top-level text fields only) refuses two documents of the type with the same value in the same locale, checked against drafts and published copies.

## Required, drafts and validation

- Every field is required unless wrapped in `v.optional(...)`. An empty array satisfies a required `v.array`.
- **Drafts save even when invalid.** `documents.create` / `documents.update` store the draft and return its `issues` (`[{ path, message }]`), so editors can save work in progress.
- **Publishing requires a valid document.** `documents.publish`, scheduling, and writes with `publish: true` fail with `UNPROCESSABLE_CONTENT` and the issues.
- Keys a schema doesn't declare are dropped on write.
- References must point at existing documents, and a referenced document can't be deleted while referenced (`CONFLICT`, with the references).

## Unions

A union of objects with a `v.literal` discriminant gets a type picker in the editor, and narrowing on the discriminant narrows the TypeScript type:

```ts
// examples/schemas/src/unions.ts
// A union of objects told apart by a literal `kind`: the editor shows a type picker,
// and narrowing on `kind` narrows the TypeScript type.
const link = v.union([
  v.object({ kind: v.literal("internal"), page: v.ref("page") }, { label: "Page on this site" }),
  v.object({ kind: v.literal("external"), url: v.text({ format: "url" }) }, { label: "Web address" }),
  v.object({ kind: v.literal("email"), address: v.text({ format: "email" }) }, { label: "Email" })
]);
```

An array of such a union is how block lists work: `vibe-cms docs blocks`.

## Types

```ts
// examples/schemas/src/queries.ts
// The stored shape (what you write) and the query shape (what you read).
export type EventInput = Infer<typeof event>;
export type EventResult = InferOutput<typeof event>;
```

`Infer` and `InferOutput` (from `vibe-cms`) take a schema or a collection (`config.schemas.event`). They differ for media: the stored shape has `{ asset: "ast_…", alt }`, the output adds `url`, `width`, `mime` and so on. Query results are typed for you; see `vibe-cms docs queries`.

Schemas are also Standard Schema: `config.schemas.event["~standard"].validate(value)` validates the stored shape (references and `unique` need the database, so only the engine checks those), and `~standard.jsonSchema.input()` returns JSON Schema.

## Changing a schema

Stored content isn't migrated when a schema changes. Read `vibe-cms docs schema-changes` before renaming, retyping or making a field required on a site with content.
