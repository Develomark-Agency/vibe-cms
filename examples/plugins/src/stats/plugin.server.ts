import { desc, eq } from "vibe-cms/query";
import { defineServer } from "vibe-cms/server";
import config from "../../vibe-cms.config.ts";
import type { StatsPlugin } from "./index.ts";

const { post } = config.schemas;

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
    // POST /_vibe/plugins/stats/latest: what `cms.plugins.stats.latest({ limit })` calls from the editor.
    "POST /latest": async request => {
      const { limit = 5 } = await request.json() as { limit?: number };
      const posts = await cms.query(post).findMany({ orderBy: [desc(post.wordCount)], limit });
      return Response.json(posts.map(p => ({ title: p.title, slug: p.slug })));
    }
  }
}));
