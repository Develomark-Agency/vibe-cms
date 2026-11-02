# Plugin routes and pages

A plugin's HTTP routes, its pages in the editor and their nav links: how to declare them, the URLs they end up at, and how to call routes from the editor and the site.

The `stats` plugin in `examples/plugins` has all of these. With the default `/_vibe` prefix and a plugin named `stats`:

| You declare | In | It ends up at |
|---|---|---|
| route `"GET /summary"` | server entry `routes` | `GET /_vibe/plugins/stats/summary` |
| route `"GET /words/:slug"` | server entry `routes` | `GET /_vibe/plugins/stats/words/<slug>` |
| page `"/"` | admin entry `pages` | `/_vibe/admin/p/stats` |
| page `"/words/:slug"` | admin entry `pages` | `/_vibe/admin/p/stats/words/<slug>` |
| nav item `to: "/"` | admin entry `slots.nav` | a sidebar link to `/_vibe/admin/p/stats` |

Routes are under `/_vibe/plugins/<name>/`, not `/_vibe/api/`: `/_vibe/api/` is the CMS's own API. Editor pages and nav links are relative to the plugin: the editor puts `/p/<name>` in front of them, so two plugins can both have a `/` page.

## Routes

```ts
// examples/plugins/src/stats/plugin.server.ts
// Routes are served at `/_vibe/plugins/stats/<path>`, not under `/_vibe/api/`.
export default defineServer<typeof StatsPlugin, typeof config>(({ cms }) => ({
  routes: {
    // GET /_vibe/plugins/stats/summary: editors only.
    "GET /summary": async (_request, { session }) => {
      if(!session) return Response.json({ error: "Sign in required" }, { status: 401 });
      const [drafts, published, pinned] = await cms.batch([
        cms.query(post, { drafts: true }).count(),
        cms.query(post).count(),
        cms.query(post, { drafts: true }).count({ where: eq(post.pinned, true) })
      ]);
      return Response.json({ drafts, published, pinned });
    },
    // GET /_vibe/plugins/stats/words/:slug: `:slug` arrives in `params`.
    "GET /words/:slug": async (_request, { params }) => {
      const found = await cms.query(post).findFirst({ where: eq(post.slug, params.slug!) });
      if(!found) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json({ slug: found.slug, words: found.wordCount ?? 0 });
    },
```

- Keys are `"METHOD /path"`. A key without a method (`"/path"`) matches any method. `:name` segments arrive URL-decoded in `params`; a final `*` matches the rest of the path as `params["*"]`.
- A handler gets the standard `Request` and `{ params, session }`, and returns a `Response`.
- Unmatched paths and methods answer 404 `{ "error": "Not found" }`. A handler that throws answers 500 `{ "error": "Internal error" }` and is logged.
- The CMS adds no CORS headers to plugin routes. Add them yourself if browsers on other origins call the route.

### Who is calling

`session` is the signed-in editor or agent (`{ sub, email, name, roles }`), from a bearer token or the editor's cookie, or `null` for anonymous requests. Routes are public unless you check: the CMS applies no permissions to them. Check `session` for "any signed-in user", and `session.roles` for more. On development sites, the dev sign-in's session has `roles: ["dev"]`.

## Editor pages and nav

```ts
// examples/plugins/src/stats/plugin.admin.tsx
export default defineAdmin(() => ({
  // Page keys and nav `to` are relative to the plugin: the editor prefixes them with /p/stats.
  pages: {
    "/": { title: "Stats", component: StatsPage },
    "/words/:slug": { title: "Words", component: WordsPage }
  },
  slots: {
    nav: [{ label: "Stats", to: "/", icon: "chart-bar" }]
  }
}));
```

A page component gets `{ cms, params }`; `params` holds the page key's `:name` segments. Nav items take `label`, `to` and an optional `icon`, either a name from the editor's icon set (a type error if unknown) or your own component.

## Calling routes from the editor

The editor's client, `cms`, sends the editor's credentials with every request, so routes see the signed-in `session`:

```ts
// examples/plugins/src/stats/plugin.admin.tsx
  // `cms.api` paths starting with /plugins/ go to /_vibe/plugins/…, everything else to /_vibe/api/….
  const summary = useJson(() => cms.api<{ drafts: number, published: number, pinned: number }>("/plugins/stats/summary"));
  // `cms.plugins.<plugin>.<route>(body)` is a POST to /_vibe/plugins/<plugin>/<route> with a JSON body.
  const latest = useJson(() => cms.plugins.stats!.latest!({ limit: 3 }) as Promise<Array<{ title: string, slug: string }>>);
```

| Call | Request |
|---|---|
| `cms.api("/plugins/stats/summary")` | `GET /_vibe/plugins/stats/summary` |
| `cms.api("/plugins/stats/x", { method: "POST", json: body })` | `POST /_vibe/plugins/stats/x` with a JSON body |
| `cms.plugins.stats.latest({ limit: 3 })` | `POST /_vibe/plugins/stats/latest` with `{"limit":3}` (one path segment, always POST) |
| `cms.api("/info")` | `GET /_vibe/api/info` (anything not starting with `/plugins/`) |

Both resolve to the parsed JSON body and throw on a non-2xx answer, with the response's `error` as the message. `cms.plugins` is typed as a plain record, hence the `!` under `noUncheckedIndexedAccess`, and returns `unknown`.

To open one of the plugin's pages, `cms.navigate` takes an editor path without `/_vibe/admin`:

```tsx
// examples/plugins/src/stats/plugin.admin.tsx
          // `cms.navigate` takes editor paths, without /_vibe/admin: this opens /_vibe/admin/p/stats/words/<slug>.
          <li key={p.slug}><button type="button" onClick={() => cms.navigate(`/p/stats/words/${p.slug}`)}>{p.title}</button></li>
```

## Calling routes from the site

From the site's pages, call the full path. Public routes need no credentials:

```ts
const response = await fetch(`/_vibe/plugins/counter/hit/${post.id}`, { method: "POST" });
const { hits } = await response.json();
```

```ts
// examples/plugins/src/counter/plugin.server.ts
  routes: {
    // Public: POST /_vibe/plugins/counter/hit/<id> from the site's pages.
    "POST /hit/:id": async (_request, { params }) => {
      const counter = bindings.counters.get(bindings.counters.idFromName(params.id!));
      return Response.json({ hits: await counter.hit() });
    }
  }
```

Server-side code in the same Worker doesn't need HTTP for content: use `vibe.client(env)` (`vibe-cms docs queries`). If the site changed the config's `prefix`, routes move with it: `<prefix>/plugins/<name>/…` and `<prefix>/admin/p/<name>/…`.
