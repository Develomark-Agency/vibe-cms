# Config

Every option `defineConfig` takes, how collections appear in the editor, and how the site's name, accent and icon relate to the config.

The config is the default export of `vibe-cms.config.ts`. `defineConfig` checks its strings against its own schemas at the type level: collection keys, `title` fields, `preview` placeholders, icons, role rules, locales and `v.ref()` targets are all type errors when wrong.

```ts
import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

export default defineConfig({
  id: "acme-site",
  name: "Acme",
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
| `auth` | none | `oidc({ issuer, clientId, roles? })` from `vibe-cms/auth`: how editors sign in on deployed sites. See `vibe-cms docs permissions`. |
| `permissions` | none | Roles and users. See `vibe-cms docs permissions`. |
| `id` | the host name | Stable site ID, published in `/.well-known/vibe-cms`. |
| `name` | the host name | The site's default display name (see Site settings below). |
| `prefix` | `"/_vibe"` | URL prefix for everything the CMS serves. |
| `trash` | `{ days: 30 }` | How long deleted documents and files stay restorable before the cron trigger purges them. |

The config object is also how site code reaches content types: `config.schemas.post` is what you pass to `cms.query(…)`, and `config.schemas.post.slug` is a column for `where` and `orderBy`.

## Collections

`collections` controls how each content type looks in the editor. None of it changes what's stored.

```ts
// examples/schemas/src/collections.ts
  collections: {
    // `title` names the text field shown in lists; `preview` builds the "View on site" link.
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
| `preview` | The document's URL on the site, for "View on site". `{field}` placeholders come from the document; `{id}` and `{locale}` also work. Slashes in values are kept, so `"{path}"` works for path fields. |
| `singleton` | Exactly one document of this type, e.g. a homepage or footer content. Read it with `findFirst()`. |

## Site settings: name, accent and icon

Every site has three built-in settings that editors change on the editor's **Site** page: name, accent colour and icon. They're stored in the database, not in code.

- **Name** resolves in this order: the name saved on the Site page, then `name` from the config, then the host name (`localhost` in development). `vibe.site(env)` has no request to take a host from, so its last fallback is the config's `id`, else `"site"`: set `name` in the config.
- Saving the Site page only stores what the editor changed. Saving the name that's already the default (the config's `name`, or the host name without one) stores no override, so a `name` you add to the config later still shows through.
- If an editor did set a name, it wins over the config. The Site page offers **Use the name from code** to clear the override, and so does saving the config's name again: `bunx vibe-cms site update --name "<config name>" --site <url>`.
- Accent and icon have no config equivalent. Without them the editor is neutral (or takes the panel's accent when opened from it) and shows the name's initial.
- Changing the name needs the `siteSettings: true` role rule (or `all`).

Read them in your site's pages with `vibe.site(env)` (`{ name, accent, icon }`, icon URLs root-relative). The panel reads them from `/.well-known/vibe-cms`. Content-like settings (a tagline, footer text) belong in a singleton collection instead.
