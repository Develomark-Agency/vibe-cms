# Config

Every option `defineConfig` takes, how collections are declared and appear in the editor, and where the site's identity (ID, name, accent, icon) lives instead.

The config is the default export of `vibe-cms.config.ts`. Each content type is a collection: its schema, with its editor settings beside it. `defineConfig` checks the config's strings at the type level: a collection's `title` and `preview` placeholders against its own schema, and icons, role rules, locales and `v.ref()` targets, are all type errors when wrong.

```ts
import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

export default defineConfig({
  locales: ["en", "fr"],
  collections: {
    post: {
      icon: "newspaper",
      preview: "/posts/{slug}",
      schema: v.object({ title: v.text(), slug: v.text({ format: "slug", unique: true }) })
    }
  }
});
```

## Options

| Option | Default | What |
|---|---|---|
| `collections` | (required) | Content types: name → `{ schema, …settings }` (below). Names start with a letter; letters, digits, `_` and `-`. See `vibe-cms docs schemas`. |
| `plugins` | `[]` | Plugin descriptors, e.g. `[SearchPlugin({ … })]`. See `vibe-cms docs plugins`. |
| `locales` | `[defaultLocale]` | Locales documents can be translated into. See `vibe-cms docs localization`. |
| `defaultLocale` | first of `locales`, else `"en"` | The locale reads fall back to. |
| `prefix` | `"/_vibe"` | URL prefix for everything the CMS serves. |

The config object is also how site code reaches content types: `config.schemas.post` is what you pass to `cms.query(…)`, and `config.schemas.post.slug` is a column for `where` and `orderBy`.

## Collections

Each collection takes its `schema` (`v.object({…})`, see `vibe-cms docs schemas`) and settings that control how the content type looks in the editor. The settings don't change what's stored.

```ts
// examples/schemas/src/collections.ts
  collections: {
    article: {
      // `title` names the text field shown in lists; `preview` is where the draft preview opens it.
      label: "Articles",
      icon: "newspaper",
      title: "headline",
      preview: "/articles/{slug}",
      schema: v.object({
        headline: v.text({ min: 1 }),
        slug: v.text({ format: "slug", unique: true }),
        body: v.text({ multiline: true })
      })
    },
    faq: {
      label: "FAQ",
      icon: "message-square",
      title: "question",
      schema: v.object({
        question: v.text(),
        answer: v.text({ multiline: true })
      })
    },
    settings: {
      label: "Site content",
      icon: "settings",
      // One document only: the editor opens it directly instead of listing documents.
      singleton: true,
      schema: v.object({
        footerText: v.optional(v.text()),
        newsletterUrl: v.optional(v.text({ format: "url" }))
      })
    }
  }
```

| Setting | What |
|---|---|
| `schema` | (required) The stored shape: `v.object({…})`. |
| `label` | Name in the editor's navigation. Defaults to the content type's name. |
| `icon` | An icon from the editor's set (`newspaper`, `user`, `home`, `layout`, `settings`, …; the type lists them all). |
| `title` | Text field used as the document title in lists. Defaults to the first text field. |
| `preview` | The document's URL on the site, where the editor's draft preview opens it (`vibe-cms docs preview`). `{field}` placeholders come from the document; `{id}` and `{locale}` also work. Slashes in values are kept, so `"{path}"` works for path fields. |
| `url` | Where the document lives on the site, for redirects (`vibe-cms docs redirects`): a function of the document, or a template like `preview`. Defaults to `preview` when that is a path, and to `path` for `pageSchema()` collections. |
| `singleton` | Exactly one document of this type, e.g. a homepage or footer content. Read it with `findFirst()`. |

## Site identity: ID, name, accent and icon

None of these are in the config. They're stored in the site's database.

- **ID**: a random ID like `site_lq3x9k2a8f7d4m1p`, made the first time the CMS boots against a database. Panels key sites by it, and session tokens are issued for it. Each database is its own site, so local, staging and production get different IDs. Two sites can't claim the same one by accident.
- **Name, accent and icon** are what editors set on the editor's **Site** page. Until a name is saved, the site shows its host name (`localhost` in development). Changing any of them needs the `siteSettings: true` role rule (or `all`).
- **Favicon**: without an icon from the Site page, the editor and the panel show the site's own favicon. That's the best `<link rel="icon">` (or `apple-touch-icon`) on its home page, else `/favicon.ico`. The CMS reads it in-process from your Worker's `fetch` and assets, on the first request and then once a day. Without either an icon or a favicon, the mark is the name's first letter on the accent.

Read them in your site's pages with `vibe.site(env)` (`{ id, name, accent, icon, favicon }`, URLs root-relative). The panel reads them from `/.well-known/vibe-cms`. Content-like settings (a tagline, footer text) belong in a singleton collection instead.
