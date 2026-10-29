import { definePlugin } from "vibe-cms";
import type { ViewCounter } from "./counter.server.ts";

export { ViewCounter } from "./counter.server.ts";

export interface ViewsOptions {
  /** Content types whose page views are counted. */
  types?: string[]
}

/**
 * Counts page views per document in a Durable Object, shows them in the
 * editor, and keeps a reading-time estimate on posts.
 */
export const ViewsPlugin = definePlugin<{
  counters: DurableObjectNamespace<ViewCounter>
}>()((options: ViewsOptions = {}) => ({
  name: "views",
  options,
  server: () => import("./plugin.server.ts"),
  admin: () => import("./plugin.admin.tsx"),
  // Re-exported from the Worker entry by `vibe-cms/exports`.
  exports: { from: import.meta.url, names: ["ViewCounter"] }
}));
