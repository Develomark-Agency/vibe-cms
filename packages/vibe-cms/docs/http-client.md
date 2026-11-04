# Reading content over HTTP

Read a site's content from outside its Worker: `createClient` for typed queries from scripts, other apps and browsers, the raw `POST /_vibe/api/query` endpoint, and `useContent` for React.

Inside the site's own Worker, use `vibe.client(env)` instead: it runs in-process with no HTTP round trip (`vibe-cms docs queries`). Everything here follows `examples/client`, which reads `examples/worker`.

To write content from outside, use actions (`vibe-cms docs agents`, `vibe-cms docs cli`): this page is reads only.

## `createClient`

```ts
// examples/client/src/read.ts
import { createClient } from "vibe-cms/client";
import { eq } from "vibe-cms/query";
// The site's config: its collections build the queries and its types type the results.
// It's plain data (plugins and widgets load their code lazily), so it's safe to import outside the Worker.
import config from "../../worker/vibe-cms.config.ts";

const url = process.env.SITE_URL ?? "http://localhost:1340";
const { post } = config.schemas;

// Published content is public: no token needed.
const cms = createClient<typeof config>({ url });

const posts = await cms.query(post).findMany({ limit: 10 });
console.log(posts.map(entry => `${entry.title} → /posts/${entry.slug}`));

const hello = await cms.query(post).findFirst({ where: eq(post.slug, "hello") });
console.log(hello?.body);

// Several queries in one request.
const [count, latest] = await cms.batch([cms.query(post).count(), cms.query(post).findFirst()]);
console.log({ count, latest: latest?.title });
```

The client is the same `QueryClient` as `vibe.client(env)`, so every query in `vibe-cms docs queries` works here. You need the site's config (or a copy of it) to build queries: share it from the site's package or a monorepo.

| Option | What |
|---|---|
| `url` | The site's origin |
| `token` | A site session token, for `drafts: true` |
| `prefix` | If the config changes `prefix` from `/_vibe` |
| `fetch` | A custom `fetch`, e.g. a service binding's |

Failed requests reject with a `ClientError` carrying `status`, `message` and `details` (the response's `data`).

## Drafts

Published reads are public. Reading working copies (`{ drafts: true }`) needs a site session token, sent as `Authorization: Bearer <token>`:

```ts
// examples/client/src/drafts.ts
const cms = createClient<typeof config>({ url, token: process.env.VIBE_TOKEN ?? await devToken() });

// Working copies, including documents that were never published.
const drafts = await cms.query(config.schemas.post, { drafts: true }).findMany();
console.log(drafts.map(entry => `${entry.title} (${entry.$meta.status})`));
```

Development sites give a token to anyone who asks (`POST /_vibe/api/session` with `{ "dev": true }`). Deployed sites issue tokens to people signed in through the panel; sessions last 12 hours. Without a token, a draft query fails with `401 { "error": "Sign in required", "code": "UNAUTHORIZED" }`.

## The raw endpoint

`POST /_vibe/api/query` takes a list of serialized queries (at most 50) and answers with their results in order. It's CORS-enabled, so browsers on other origins can call it.

```ts
// examples/client/src/raw.ts
const response = await fetch(`${url}/_vibe/api/query`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    queries: [
      { type: "post", op: "findMany", args: { orderBy: [{ path: ["title"], dir: "asc" }], limit: 10 } },
      { type: "post", op: "findFirst", args: { where: { op: "eq", path: ["slug"], value: "hello" } } },
      { type: "post", op: "count", args: {} }
    ]
  })
});

// `{ results: [...] }`, one per query in order; failures are `{ error, code, data? }` with a 4xx status.
console.log(JSON.stringify(await response.json(), null, 2));
```

- `op` is `findMany`, `findFirst`, `findById` (with `args.id`) or `count`.
- `args` takes `where`, `orderBy`, `limit` (default 100, at most 1000), `offset`, `locale` and `with`, the same as the typed client. `where` is the condition tree the `vibe-cms/query` helpers build (`eq(post.slug, "hello")` is `{ op: "eq", path: ["slug"], value: "hello" }`).
- Add `"drafts": true` to a query, and a bearer token, for working copies.
- Each document comes back with `id` and `$meta` (`locale`, `createdAt`, `updatedAt`, `publishedAt`, `status`).

## React: `useContent`

```tsx
// examples/client/src/Posts.tsx
const cms = createClient<typeof config>({ url: "https://example.com" });
const { post } = config.schemas;

// Runs both queries once, batched into one request, when the component mounts.
export function Posts() {
  const content = useContent(cms, q => ({
    posts: q(post).findMany({ orderBy: [desc(post.title)], limit: 10 }),
    total: q(post).count()
  }));
  if(content.loading) return <p>Loading…</p>;
  if(content.error) return <p>{content.error.message} <button onClick={content.refresh}>Retry</button></p>;
  return (
    <>
      <p>{content.data.total} posts</p>
      <ul>{content.data.posts.map(entry => <li key={entry.id}>{entry.title}</li>)}</ul>
    </>
  );
}
```

`useContent` runs its queries on mount, batched into one request, and again when `deps` (its third argument) change or `refresh()` is called. It doesn't subscribe to updates. On the server (React Server Components, Astro), await the queries directly instead.
