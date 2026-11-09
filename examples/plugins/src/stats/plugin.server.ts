import { desc, eq } from "vibe-cms/query";
import { defineAction, defineServer } from "vibe-cms/server";
import { z } from "zod";
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
  },
  instructions: "Call stats_longest to find the longest published posts, and stats_countWords to count the words in an uploaded text file.",
  // Actions are served by name as `stats.longest`, never anonymously: over REST (`POST /_vibe/api/actions/stats.longest`),
  // the CLI (`vibe-cms action stats.longest --input '{"limit":3}'`), and, since this one says `mcp: true`, to agents as `stats_longest`.
  actions: {
    longest: defineAction({
      summary: "Longest posts",
      description: "The published posts with the most words, longest first.",
      readOnly: true,
      mcp: true,
      input: z.object({ limit: z.number().int().min(1).max(20).default(5).describe("How many posts") }),
      handler: async ({ input }) => {
        const posts = await cms.query(post).findMany({ orderBy: [desc(post.wordCount)], limit: input.limit });
        return posts.map(p => ({ title: p.title, slug: p.slug, words: p.wordCount ?? 0 }));
      }
    }),
    // Files aren't action input: an agent uploads with `assets_upload` and passes the asset's ID.
    countWords: defineAction({
      summary: "Count words in a text file",
      description: "The number of words in an uploaded text file.",
      readOnly: true,
      mcp: true,
      input: z.object({ asset: z.string().describe("An asset's ID, from assets_upload or assets_list") }),
      handler: async ({ input, engine }) => {
        const file = await engine.readAsset(input.asset);
        return { name: file.name, words: (await file.text()).split(/\s+/).filter(Boolean).length };
      }
    })
  }
}));
