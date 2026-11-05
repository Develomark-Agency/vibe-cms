import alchemy from "alchemy";
import { D1Database, DurableObjectNamespace, R2Bucket, Website } from "alchemy/cloudflare";
import type { ViewCounter } from "./src/plugins/views/counter.server.ts";

const app = await alchemy("vibe-blog");

// vibe-cms never provisions anything: these are the resources it's handed in src/cms.ts.
const db = await D1Database("db", { adopt: true });
const media = await R2Bucket("media", { adopt: true });
// Binding for the example views plugin (its class is exported through `vibe-cms/exports`).
const viewCounters = DurableObjectNamespace<ViewCounter>("view-counters", { className: "ViewCounter", sqlite: true });

export const site = await Website("site", {
  build: "astro build",
  dev: "astro dev",
  // @astrojs/cloudflare (via @cloudflare/vite-plugin) bundles the Worker;
  // Alchemy uploads its output as is.
  entrypoint: "dist/server/entry.mjs",
  noBundle: true,
  assets: "dist/client",
  // Server-rendered: unknown paths go to the Worker, not to an index.html.
  spa: false,
  // global_fetch_strictly_public: lets the site and a panel on workers.dev in the same account call each other.
  compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
  bindings: { DB: db, MEDIA: media, VIEW_COUNTERS: viewCounters },
  // Runs scheduled publishing.
  crons: ["* * * * *"],
  // The Astro adapter reads this file, so `astro dev` gets the same bindings,
  // and builds our own entry instead of Astro's default one.
  wrangler: { path: "wrangler.jsonc", main: "src/worker.ts" }
});

console.log({ url: site.url });

await app.finalize();
