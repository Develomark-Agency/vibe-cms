# Storage

Content is stored as **JSON documents in D1**. Media lives in **R2**. We take the easy path: no per-type tables.

## Documents

Rough shape of the core tables:

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

These indexes are created by the engine's migrations at runtime, not generated into your repo.

## v1 features

All in scope for v1:

| Feature | How |
|---|---|
| Drafts | `documents.draft` is always the working copy |
| Publishing | `published_ver` points at an immutable snapshot in `versions` |
| Version history | `versions` is append-only; restore = copy a snapshot into `draft` |
| Scheduling | `schedules` rows, executed by the CMS's `scheduled` handler (cron trigger) |
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

## Open questions

- **Schema changes on existing content.** `schema_hash` records which schema a document was written under, but the migration story (lazy, versioned migration functions in the config?) is not designed yet.
- **When engine migrations run** (first request, explicit admin action, or a CLI step).
