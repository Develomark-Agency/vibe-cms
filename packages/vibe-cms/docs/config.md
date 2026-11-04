# Config

Every option `defineConfig` takes, how collections appear in the editor, and and where the site's identity (ID, name, accent, icon) lives instead.

The config is the default export of `vibe-cms.config.ts`. `defineConfig` checks its strings against its own schemas at the type level: collection keys, `title` fields, `preview` placeholders, icons, role rules, locales and `v.ref()` targets are all type errors when wrong.

```ts
import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

export default defineConfig({
  locales: ["en", "fr"],
  schemas: {
    post: v.object({ title: v.text(), slug: v.text({ format: "slug", unique: true }) })
  },
  collections: {
    post: { icon: "newspaper", preview: "/posts/{slug}" }
  }
});
```

## Options

| Option | Default | What |
|---|---|---|
| `schemas` | (required) | Content types: name → `v.object({…})`. Names start with a letter; letters, digits, `_` and `-`. See `vibe-cms docs schemas`. |
| `collections` | `{}` | Editor settings per content type (below). |
| `plugins` | `[]` | Plugin descriptors, e.g. `[SearchPlugin({ … })]`. See `vibe-cms docs plugins`. |
| `locales` | `[defaultLocale]` | Locales documents can be translated into. See `vibe-cms docs localization`. |
| `defaultLocale` | first of `locales`, else `"en"` | The locale reads fall back to. |
| `auth` | none | `hub({ url, roles? })` from `vibe-cms/auth`: the agency hub everyone signs in through on deployed sites. See `vibe-cms docs permissions`. |
| `permissions` | none | Roles and users. See `vibe-cms docs permissions`. |
| `prefix` | `"/_vibe"` | URL prefix for everything the CMS serves. |
| `trash` | `{ days: 30 }` | How long deleted documents and files stay restorable before the cron trigger purges them. |
| `backups` | `false` | `true` lets the hub in `auth` take and restore scheduled backups (`vibe-cms docs backups`). |

The config object is also how site code reaches content types: `config.schemas.post` is what you pass to `cms.query(…)`, and `config.schemas.post.slug` is a column for `where` and `orderBy`.

## Collections

`collections` controls how each content type looks in the editor. None of it changes what's stored.

```ts
// examples/schemas/src/collections.ts
  collections: {
    // `title` names the text field shown in lists; `preview` is where the draft preview opens it.
    article: { label: "Articles", icon: "newspaper", title: "headline", preview: "/articles/{slug}" },
    faq: { label: "FAQ", icon: "message-square", title: "question" },
    // One document only: the editor opens it directly instead of listing documents.
    settings: { label: "Site content", icon: "settings", singleton: true }
  }
```

| Setting | What |
|---|---|
| `label` | Name in the editor's navigation. Defaults to the content type's name. |
| `icon` | An icon from the editor's set (`newspaper`, `user`, `home`, `layout`, `settings`, …; the type lists them all). |
| `title` | Text field used as the document title in lists. Defaults to the first text field. |
| `preview` | The document's URL on the site, where the editor's draft preview opens it (`vibe-cms docs preview`). `{field}` placeholders come from the document; `{id}` and `{locale}` also work. Slashes in values are kept, so `"{path}"` works for path fields. |
| `singleton` | Exactly one document of this type, e.g. a homepage or footer content. Read it with `findFirst()`. |

## Site identity: ID, name, accent and icon

None of these are in the config. They're stored in the site's database.

- **ID**: a random ID like `site_lq3x9k2a8f7d4m1p`, made the first time the CMS boots against a database. Panels key sites by it, and session tokens are issued for it. Each database is its own site, so local, staging and production get different IDs. Two sites can't claim the same one by accident.
- **Name, accent and icon** are what editors set on the editor's **Site** page. Until a name is saved, the site shows its host name (`localhost` in development). Changing any of them needs the `siteSettings: true` role rule (or `all`).
- **Favicon**: without an icon from the Site page, the editor and the panel show the site's own favicon. That's the best `<link rel="icon">` (or `apple-touch-icon`) on its home page, else `/favicon.ico`. The CMS reads it in-process from your Worker's `fetch` and assets, on the first request and then once a day. Without either an icon or a favicon, the mark is the name's first letter on the accent.

Read them in your site's pages with `vibe.site(env)` (`{ id, name, accent, icon, favicon }`, URLs root-relative). The panel reads them from `/.well-known/vibe-cms`. Content-like settings (a tagline, footer text) belong in a singleton collection instead.
