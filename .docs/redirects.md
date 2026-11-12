# Redirects

Status: built. User guide: `packages/vibe-cms/docs/redirects.md`. Differences from the proposal below are listed at the end.

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
- **Permission:** a role setting `manageRedirects`; not part of site settings.

## Later

- **Recent 404s:** record not-found paths the site's `fetch` returns (count and last seen, capped) and offer "Add redirect" from that list.

## Decisions on the open questions

- **Locale:** rules match the request path alone. A locale prefix is part of the path (`/fr/ancien`), and `locale` is only a label. If core ever resolves the locale before the handler (domain or cookie based sites), matching on `(locale, from)` can be added without migrating rules: existing rows have no locale and keep matching everywhere.
- **Plugins:** no write path of their own. A plugin calls the same `redirects.*` actions as anyone, so it gets the save checks, permissions and the audit log. A migration import is `redirects.import`.

## What differs from the proposal

- Rules also store `document_type`, so the list can link an automatic rule to its page.
- Automatic rules are made by `documents.publish` (`redirect: true`) and `documents.delete` (`redirectTo`), so the rule and the change that caused it share one request. `redirects.suggest` tells the editor what to offer.
- `url` on a collection falls back to a `preview` template that is a site path, then to `pageSchema()`'s `path` field.
- Besides what the proposal lists, an automatic rule disappears when its page returns: restored from the trash, or renamed back to the address it left.
- `redirects.import` and the REST routes `GET/POST /redirects`, `POST /redirects/import`, `PATCH/DELETE /redirects/:id` and `GET /documents/:type/:id/redirect` exist.
- Named segments (`/hello/{a}/bye/{b}`) are matched by a separate list that rules without them never reach, so static rules behave as before. Variables are single segments, copied as they came in the path, and can be used in the target's path or query.
- `from` may ask for query parameters (`/place?town={name}`), matched by a list checked before the others that is empty on sites without such rules. Matched parameters are consumed; two rules differing only in a variable's name count as the same rule.
- Deleting a page in the editor opens the Redirects page with the old address filled in, tied to the page (`deletedDocument`), instead of asking for a target in the dialog. `documents.delete`'s `redirectTo` stays for agents.
- Not built: choosing the target from a list of pages, and "Recent 404s".

