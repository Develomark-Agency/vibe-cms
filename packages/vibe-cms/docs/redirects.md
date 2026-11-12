# Redirects

Send visitors from an old path to a new one, before your site's own pages are looked up, and keep links and search rankings when a page's address changes.

Editors manage them on the editor's Redirects page (Settings → Redirects). They are also actions, `redirects.list`, `redirects.create`, `redirects.update`, `redirects.delete` and `redirects.import`, so agents, the CLI and REST can manage them, and the activity log records every change.

## Rules

- **From** is a path: `/old-page`. End it with `/*` to match everything under it: `/blog/*`.
- **To** is a path, a full URL, or with a wildcard `from`, a target with `*` for what was matched: `/blog/*` → `/news/*`.
- **Status** is 301 (the default), 302, 307 or 308. **Keep query** passes the visitor's query string on.
- Matching is on the path only, never regexes. An exact rule wins, then the longest wildcard. A trailing slash and the case of percent-escapes don't matter; the case of letters does.
- Redirects apply to `GET` and `HEAD` requests, and never to the CMS's own routes (`/_vibe`).
- A relative target takes on the visitor's trailing slash, so a site that uses `/about/` isn't redirected twice.

Saving checks the rule: no loops (`/a` → `/b` → `/a`, also through wildcards), no `/_vibe` paths, one rule per `from`. It warns when `from` is a live page, since the redirect would hide it. Rules that already led to `from` are re-pointed to the new target, so visitors are never sent through more than one hop.

Locale prefixes are part of the path: a French page at `/fr/ancien` is a rule from `/fr/ancien`. A rule's `locale` is only a label for the editor.

## Automatic redirects

When publishing changes a page's address, the review screen offers “Redirect `/old` → `/new`”, ticked by default. Deleting a published page asks where visitors should go instead (optional). Restoring the page from the trash takes that redirect away, and so does renaming a page back to the address it had.

For that, the CMS needs to know where a document lives. In order, a collection's address is:

1. its `url` setting: a function of the document, or a template like `preview`'s;
2. its `preview` setting, when that is a path on the site (`"/posts/{slug}"`);
3. the `path` field that `pageSchema()` gives its pages.

```ts
collections: {
  // Return null for a document with no page.
  event: { url: doc => (doc.slug ? `/events/${doc.slug}` : null) },
  post: { preview: "/posts/{slug}" }
}
```

Without one of these, nothing is suggested for that content type.

From code, `documents.publish` takes `redirect: true` and `documents.delete` takes `redirectTo`. `redirects.suggest` says what publishing would offer.

## How they're served

The handler checks redirects after its own `/_vibe` routes and before your `fetch`. Each running Worker keeps the rules in memory and asks the database whether they changed every few seconds, so a request costs no query in between, and edits reach every instance within about five seconds. Hit counts are written in the background and batched, so they lag a little.

A problem looking redirects up never takes the site down: the request carries on to your `fetch`.

## Permission

The role setting `manageRedirects` gives access to the Redirects page and actions. Roles with `siteSettings` have it too, unless `manageRedirects: false`. People who can publish see the automatic offer only with it.

## CSV

Import takes a file with `from`, `to`, and optionally `status` and `keepQuery` columns (with or without a header row), up to 5000 rows per call. Rows that can't be added are skipped and listed with the reason. Export writes the same columns.
