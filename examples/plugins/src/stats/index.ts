import { definePlugin } from "vibe-cms";

/** HTTP routes, an editor page with a nav link, and a public endpoint. */
export const StatsPlugin = definePlugin()(() => ({
  name: "stats",
  options: {},
  server: () => import("./plugin.server.ts"),
  admin: () => import("./plugin.admin.tsx")
}));
