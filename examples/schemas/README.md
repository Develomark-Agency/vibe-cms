# Schemas example

Content type definitions for <span style="white-space: nowrap">Vibe CMS</span>, one topic per file, plus the queries that read them. No site: each file's config can be dropped into any of the framework examples (`examples/astro`, `examples/worker`).

| File | Shows |
|---|---|
| `src/fields.ts` | Every field type and its options |
| `src/collections.ts` | Editor settings: labels, icons, title field, preview links, singletons |
| `src/references.ts` | `v.ref()` to one type, to any type, in arrays |
| `src/media.ts` | `image()`, `video()`, `file()` and `v.asset()` |
| `src/unions.ts` | Unions of objects told apart by a literal |
| `src/localization.ts` | Locales, fallback, translator roles |
| `src/permissions.ts` | Roles and users (sign-in comes from `VIBE_ORG`) |
| `src/presets.ts` | Rich text, blocks and pages from `@vibe-cms/rich-text` and `@vibe-cms/blocks` |
| `src/queries.ts` | Filtering, sorting, paging, counting, batching, drafts, `with` expansions, locales |
| `src/backfill.ts` | A script that copies a field into a new one after a schema change |

`bun run typecheck` checks them. The guides quote these files: `vibe-cms docs schemas`, `vibe-cms docs queries`.
