import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";
import { CounterPlugin } from "./src/counter/index.ts";
import { EditorPlugin } from "./src/editor/index.ts";
import { MediaPlugin } from "./src/media/index.ts";
import { RulesPlugin } from "./src/rules/index.ts";
import { ScheduledPlugin } from "./src/scheduled/index.ts";
import { SlugsPlugin } from "./src/slugs/index.ts";
import { StatsPlugin } from "./src/stats/index.ts";
import { WebhookPlugin } from "./src/webhook/index.ts";
import { Rating } from "./src/widgets/rating.ts";
import { Slider } from "./src/widgets/slider.ts";

export default defineConfig({
  // Transforming hooks run in this order; each sees the previous one's changes.
  plugins: [
    SlugsPlugin(),
    RulesPlugin({ blockedWords: ["TODO"] }),
    WebhookPlugin({ types: ["post"] }),
    StatsPlugin(),
    EditorPlugin(),
    ScheduledPlugin(),
    MediaPlugin({ maxSize: 10_000_000 }),
    CounterPlugin()
  ],
  schemas: {
    post: v.object({
      title: v.text({ min: 1, max: 120 }),
      // Filled from the title by the slugs plugin when left empty.
      slug: v.text({ format: "slug", indexed: true }),
      body: v.text({ multiline: true }),
      // Derived by the slugs plugin on every write: declared so it's kept, read-only so editors can't change it.
      wordCount: v.optional(v.number({ integer: true, readOnly: true })),
      // The rules plugin refuses to delete pinned posts.
      pinned: v.boolean(),
      rating: v.optional(v.number({ integer: true, min: 1, max: 5, widget: Rating({ max: 5 }) })),
      width: v.optional(v.number({ min: 0, max: 100, widget: Slider({ step: 5 }) }))
    })
  }
});
