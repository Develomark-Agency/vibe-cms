# Localization

Translating content: configuring locales, how each document holds one version per locale, fallback in queries, and translator roles.

```ts
// examples/schemas/src/localization.ts
// Every document can have a translation per locale. Queries in another locale fall back
// to the default locale's version for documents that aren't translated yet.
export default defineConfig({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
```

- A document has one version per locale, sharing its ID. Each translation has its own draft, publishing state, versions and schedules: publishing the French version doesn't publish the English one.
- The whole document is translated; there are no per-field "localized" flags. Fields that shouldn't vary (a price, an image) are stored in each translation.
- `documents.create` and `documents.update` take a `locale` (the default locale when omitted). Updating a document in a locale it doesn't have yet creates that translation. The editor has a locale switcher on every document.
- `unique` fields are unique per locale, so a French page can reuse the English `path`.
- Deleting in a non-default locale removes only that translation.
- References point at a document; `with` resolves them in the query's locale.

## Querying a locale

```ts
// examples/schemas/src/queries.ts
export async function frenchPage(cms: Cms<typeof localization>, path: string) {
  // Falls back to English for pages without a French translation; `$meta.locale` says which you got.
  const found = await cms.query(page).findFirst({ where: eq(page.path, path), locale: "fr" });
  return found && { ...found, translated: found.$meta.locale === "fr" };
}
```

`locale` is typed to the config's `locales`. Without it, queries read the default locale. With it, each document comes back in that locale if it has a translation (published, for published reads), else in the default locale. Filters and sorting apply to whichever version each document came back in.

A common pattern is reading the locale from the URL and passing it through:

```ts
const locale = config.locales.find(l => l === url.searchParams.get("lang"));
const posts = await cms.query(post).findMany({ locale });
```

## Writing translations from code

```bash
bunx vibe-cms documents update --type page --id doc_… --locale fr --data '{"title":"À propos","path":"/about","body":"…"}' --publish --site http://localhost:1337
```

## Translator roles

`write: { locales }` in a role lets it write (translate) every type it can read, only in those locales. On the editor's **Roles** page that's the Languages row; the Translator preset starts with every locale but the default:

```ts
// examples/schemas/src/localization.ts
// Roles live in the site's database, edited on the editor's Roles page. This is a translator's
// rules there: reads everything, writes (translates) only French.
export const translator: RoleRules = { "*": ["read"], write: { locales: ["fr"] } };
```

See `vibe-cms docs permissions` for the rest of the role rules.
