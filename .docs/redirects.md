# Redirects

Status: proposed. Not built.

## Problem

Editors own page URLs through `pageSchema()` slugs. Renaming a slug or trashing a page breaks inbound links and search rankings, and nothing built in fixes it. Every site with editor-owned URLs needs redirects, so they belong in core and not in each site's code.

Plugins can't cover it well today: plugin routes are mounted under `/_vibe/plugins/<name>/`, so a plugin can't answer `/old-page` before the site's own `fetch` runs.

## Goal

A **Redirects** section on the site settings page, served by the handler, with redirects suggested automatically when URLs change.

## Rules

```
vibe_redirects
  id
  from          -- "/old-page" or "/blog/*"
  to            -- "/new-page", "/news/*" or an absolute URL
  status        -- 301 | 302 | 307 | 308
  keep_query    -- 1 / 0
  locale        -- optional
  source        -- "manual" | "slug-change" | "trash"
  document_id   -- for automatic rules, the page it came from
  created_by, created_at
  hits, last_hit_at
```

- **Matching:** exact paths, plus a single trailing `*` captured and substituted into `to`. No regexes: easy to read, and no expressions that are slow to match.
- Paths are normalized before matching (trailing slash, case of the percent-encoding). The site's own trailing-slash style is kept.
- **Order:** exact matches first, then the longest wildcard prefix.

## Serving

The handler checks redirects before passing the request to the site's own `fetch` (and after its own `/_vibe` routes, which are never redirected).

- Rules are cached in memory in each running Worker instance and reloaded when they change, using a version number in `vibe_meta`, checked at most every few seconds. A miss costs no D1 query.
- Hit counts are written in the background with `ctx.waitUntil`, batched.
- Only `GET` and `HEAD` requests are redirected.

## Automatic redirects

- **Slug change:** when a publish changes an indexed `slug` field on a document that has a URL, the publish screen offers "Redirect `/old` → `/new`", ticked by default. With [change sets](./change-sets.md) this is part of the merge screen.
- **Trash:** trashing a published page asks for a redirect target (another page, or none).
- **Chains:** when `/a` → `/b` exists and `/b` is renamed to `/c`, the rule is updated to `/a` → `/c`, so visitors are never sent through more than one hop.
- Working out a document's URL needs a mapping from a document to its path. `pageSchema()` sites have one convention; others need a config option (`url: (doc) => string`) on the collection. Without one, slug changes don't offer redirects.

## Checks on save

- No loops (`/a` → `/b` → `/a`), including through wildcards.
- `from` can't be a `/_vibe` path.
- Warn when `from` is a path a live page currently uses, since the redirect would hide that page.

## Interface

- **Site settings → Redirects:** list with search, add, edit, delete, hit counts, and the source of automatic rules (linking to the page).
- Import and export as CSV, for moving a site onto Vibe CMS.
- **Actions** `redirects.list`, `redirects.create`, `redirects.update`, `redirects.delete`: available through MCP, the CLI and REST, and recorded by the [audit log](./audit-log.md).
- **Permission:** a role setting `manageRedirects`; part of site settings by default.

## Later

- **Recent 404s:** record not-found paths the site's `fetch` returns (count and last seen, capped) and offer "Add redirect" from that list.

## Open questions

- Whether redirects are per locale or global, and how they work with locale prefixes in paths.
- Whether to let plugins add rules (for example, from a migration import).
