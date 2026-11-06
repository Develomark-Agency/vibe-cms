# Query API

## Schemas are the query markers

Inspired by Drizzle's relational queries: not its syntax, but the idea that you pass around typed objects that shape the query. In <span style="white-space: nowrap">Vibe CMS</span>, the schemas from the config are those objects.

```ts
import { eq, gt, desc, and, inArray } from "vibe-cms/query";

const { post, author } = config.schemas;

const posts = await cms.query(post).findMany({
  where: and(
    eq(post.layout, "default"),
    gt(post.publishedAt, new Date("2026-01-01")),
  ),
  orderBy: [desc(post.publishedAt)],
  limit: 10,
  locale: "fr",
  with: {
    author: true,
  },
});

posts[0].author.name; // typed: author was expanded via `with`
posts[0].title;       // typed from the post schema
```

```ts
const one = await cms.query(post).findFirst({
  where: eq(post.slug, "hello-world"),
});

const withNested = await cms.query(author).findMany({
  where: inArray(author.id, ids),
  with: {
    posts: {               // reverse reference: posts whose `author` points here
      orderBy: [desc(post.publishedAt)],
      limit: 3,
    },
  },
});
```

- `where` on JSON documents compiles to `json_extract(...)`. Fields marked `indexed` are fast; others work but scan.
- `with` expands `v.ref()` fields (and reverse references).
- Published content is returned by default. Drafts require an authorized client: `cms.query(post, { drafts: true })`.

## Where `cms` comes from

### Inside the site's Worker: in-process

The CMS runs inside the same Worker as the site, so querying is a function call, with no network or RPC hop.

```ts
// src/cms.ts
import config from "../vibe-cms.config";
import { createHandler } from "vibe-cms/handler";

export const vibe = createHandler(config, { bindings: (env: Env) => ({ /* … */ }) });
```

```astro
---
// src/pages/posts/[slug].astro
import { env } from "cloudflare:workers";
import { eq } from "vibe-cms/query";
import { vibe } from "../../cms";
import config from "../../../vibe-cms.config";

const cms = vibe.client(env);
const { post } = config.schemas;

const entry = await cms.query(post).findFirst({
  where: eq(post.slug, Astro.params.slug),
  with: { author: true },
});
---

<article>
  <h1>{entry.title}</h1>
  <p>By {entry.author.name}</p>
</article>
```

### Everywhere else: HTTP

Browsers, mobile apps and other services use the HTTP API under `/_vibe/api`, with the same query builder serialized over the wire.

```ts
// src/cms.client.ts
import { createClient } from "vibe-cms/client";
import type config from "../vibe-cms.config";

export const cms = createClient<typeof config>({
  url: "https://my-client-site.com",
  token: import.meta.env.PUBLIC_VIBE_READ_TOKEN, // public read-only token
});
```

## React: `useContent`

`useContent` runs its queries when the component mounts. There is no live updating in v1. `refresh()` re-runs the queries.

```tsx
import { useContent } from "vibe-cms/react";
import { eq } from "vibe-cms/query";
import { cms } from "./cms.client";
import config from "../vibe-cms.config";

const { post } = config.schemas;

export function Post(props: { slug: string }) {
  const content = useContent(cms, (q) => ({
    post: q(post).findFirst({
      where: eq(post.slug, props.slug),
      with: { author: true },
    }),
  }));

  if (content.loading) return <Spinner />;

  return (
    <article>
      <h1>{content.data.post.title}</h1>
      <button onClick={content.refresh}>Refresh</button>
    </article>
  );
}
```

All queries in one `useContent` call are batched into a single request.

## Open questions

- Exact `vibe.client(env)` surface, and how framework code reaches the handler instance cleanly (Astro, Vinext).
- Public read tokens vs. unauthenticated published reads.
- Pagination style (cursor vs. offset).
