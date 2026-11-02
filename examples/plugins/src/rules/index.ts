import { definePlugin } from "vibe-cms";

export interface RulesOptions {
  /** Posts whose title contains one of these can't be published. */
  blockedWords: string[]
}

/** Refuses some writes and deletes. */
export const RulesPlugin = definePlugin()((options: RulesOptions) => ({
  name: "rules",
  options,
  server: () => import("./plugin.server.ts")
}));
