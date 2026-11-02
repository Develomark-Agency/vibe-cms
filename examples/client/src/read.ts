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
