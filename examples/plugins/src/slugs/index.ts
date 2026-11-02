import { definePlugin } from "vibe-cms";

/** Fills in a post's slug from its title, and keeps its word count up to date. */
export const SlugsPlugin = definePlugin()(() => ({
  name: "slugs",
  options: {},
  server: () => import("./plugin.server.ts")
}));
