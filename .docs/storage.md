# Storage

Content is stored as **JSON documents in D1**. Media lives in **R2**. We take the easy path: no per-type tables.

## Documents

Rough shape of the core tables. The real definitions are Drizzle tables in `packages/vibe-cms/src/db/schema.ts` (names are prefixed `vibe_`; see [Schema and migrations](#schema-and-migrations)):

```sql
CREATE TABLE documents (
  id             TEXT NOT NULL,
  type           TEXT NOT NULL,          -- "post", "author", …
  locale         TEXT NOT NULL,          -- "en", "fr", …
  draft          TEXT NOT NULL,          -- JSON: current working copy
  published_ver  INTEGER,                -- pointer into versions, NULL if unpublished
  schema_hash    TEXT NOT NULL,          -- which schema version the draft was written under
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (id, locale)
);

CREATE TABLE versions (                  -- append-only history
  id         TEXT NOT NULL,
  locale     TEXT NOT NULL,
  ver        INTEGER NOT NULL,
  data       TEXT NOT NULL,              -- JSON snapshot
  author     TEXT NOT NULL,              -- stable identity subject, see panel-and-auth.md
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, locale, ver)
);

CREATE TABLE schedules (
  id         TEXT NOT NULL,
  locale     TEXT NOT NULL,
  ver        INTEGER NOT NULL,
  action     TEXT NOT NULL,              -- "publish" | "unpublish"
  run_at     INTEGER NOT NULL
);
```

## Indexed fields

Fields marked `indexed` get a SQLite expression index so they can be filtered and sorted efficiently.

```ts
post: v.object({
  slug: v.text({ indexed: true }),
  publishedAt: v.date({ indexed: true }),
})
```

```sql
CREATE INDEX idx_post_slug
  ON documents (json_extract(draft, '$.slug'))
  WHERE type = 'post';
```

These indexes depend on each site's config, so they're not part of the generated migrations. The engine creates them (`CREATE INDEX IF NOT EXISTS`) at runtime, as it does the full-text table `vibe_search` and its triggers. They are not generated into your repo.

## Schema and migrations

The tables are defined once, in TypeScript, with [Drizzle](https://orm.drizzle.team):

- `packages/vibe-cms/src/db/schema.ts`: the engine's tables. Row types (`DocumentRow` and so on) are inferred from it, and queries are checked against it, so renaming or dropping a column is a compile error at every query that uses it.
- `packages/vibe-cms/src/oauth/schema.ts`: `oauthTables(prefix)`, the OAuth server's tables. A site uses `vibe_`, the hub uses no prefix. Each database re-exports them as top-level consts (drizzle-kit only sees top-level exports).
- `apps/panel/src/server/schema.ts`: the panel's own tables.
- `createDb(d1)` (`src/db/client.ts`) wraps a D1 binding in Drizzle. `db.batch([...])` is one atomic D1 batch. D1 has no interactive transactions.

**Changing a table:**

1. Edit the schema file.
2. Run `bun run db:generate` in `packages/vibe-cms` (or `apps/panel`). drizzle-kit writes a numbered `.sql` file and its snapshot under `migrations/`, and `scripts/db-generate.ts` bundles the SQL into `migrations/index.ts`. Workers have no filesystem, so the bundle is what ships.
3. Commit all of it: the schema, the `.sql`, `meta/` and `index.ts`.

At runtime, `runMigrations` (`src/db/migrate.ts`) applies the migrations that haven't run, in order, each as one atomic batch, and records its tag in `vibe_migrations` (the panel: `panel_migrations`). It runs on the first request each isolate handles.

Generated statements are rewritten to `CREATE … IF NOT EXISTS`. A database made before migrations existed has every table already, so the first migration is a no-op there and just gets recorded. Don't edit an applied migration; add a new one.

Not covered by Drizzle, and left as SQL: the query-API compiler, FTS5 queries, the expression indexes and search triggers, and the restore's staging tables.

## v1 features

All in scope for v1:

| Feature | How |
|---|---|
| Drafts | `documents.draft` is always the working copy |
| Publishing | `published_ver` points at an immutable snapshot in `versions` |
| Version history | `versions` is append-only; restore = copy a snapshot into `draft` |
| Scheduling | `schedules` rows, executed by the CMS's `scheduled` handler (cron trigger) |
| Trash | deletes move rows into `trash`; restore puts them back, purge removes them for good |
| i18n | `(id, locale)` key; fallback rules configured via `locales` in the config |

```ts
// vibe-cms.config.ts
export default defineConfig({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  schemas: { /* … */ },
});
```

Scheduled publishing requires a cron trigger on the Worker:

```jsonc
// wrangler.jsonc
{
  "triggers": { "crons": ["* * * * *"] }
}
```

## Media

Uploads go to the R2 bucket supplied as `storage` in the handler bindings. Assets form one shared media library.

```sql
CREATE TABLE assets (                    -- once per file
  id         TEXT PRIMARY KEY,           -- "ast_8f2…"
  key        TEXT NOT NULL,              -- R2 key, derived from id, never from folder
  folder     TEXT,                       -- media library organization only
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  meta       TEXT NOT NULL,              -- JSON from media.analyze: width, height, duration, …
  created_at INTEGER NOT NULL
);
```

A `v.asset()` field stores a reference plus per-usage fields, never a URL:

```json
{ "cover": { "asset": "ast_8f2…", "alt": "Sunset over the bay", "focal": { "x": 0.4, "y": 0.6 } } }
```

Queries merge the asset record into the per-usage fields and add a URL. Deleting a document never deletes assets; assets no longer referenced by any document version are cleaned up separately.

Image transforms (e.g. `image.src({ width: 800 })` producing Cloudflare Images URLs) are a fast follow after v1.

## Trash

Deleting a document, one translation, or a media file moves its rows into one table instead of removing them:

```sql
CREATE TABLE trash (
  id         TEXT PRIMARY KEY,           -- "trs_…"
  kind       TEXT NOT NULL,              -- "document" | "asset"
  type       TEXT,                       -- content type, for documents
  item_id    TEXT NOT NULL,              -- the document or asset ID it restores to
  locale     TEXT,                       -- set when only one translation was deleted
  label      TEXT NOT NULL,              -- title or filename, for the Trash page
  payload    TEXT NOT NULL,              -- JSON: the removed documents rows, or the assets row
  deleted_at INTEGER NOT NULL,
  deleted_by TEXT NOT NULL
);
```

- Version history and R2 objects stay where they are, so a restore is exact: same ID, same published state, same file URL. Trashed files return 404 while they're in the trash.
- Pending schedules are dropped on delete, not restored.
- Restoring a document also restores trashed files it references.
- Restore is refused (409) if the ID and language exist again, or if it's a translation whose document is gone.
- Purging removes the trash row, then the document's versions or the file's R2 object, unless something live or another trash row still needs them.
- The `scheduled` handler purges items older than the trash retention (default 30 days), which editors set on the Trash page and which is stored with the site settings. Without a cron trigger, items stay until purged by hand.
- API: `GET /trash`, `GET /trash/:id` (each deleted language's draft, or the file's details), `GET /trash/:id/file` (a trashed file's bytes, for previews), `POST /trash/:id/restore`, `DELETE /trash/:id`, `DELETE /trash` (empty). Each item needs the same delete permission that put it there.

## Open questions

- **Schema changes on existing content.** `schema_hash` records which schema a document was written under, but the migration story (lazy, versioned migration functions in the config?) is not designed yet.
