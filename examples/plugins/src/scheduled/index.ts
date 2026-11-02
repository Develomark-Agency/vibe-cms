import { definePlugin } from "vibe-cms";

/**
 * A cron job and a queue consumer. The Worker must have the cron trigger and
 * consume the queue (wrangler `triggers.crons`, `queues.consumers`); the CMS
 * routes each event to the plugin that registered it.
 */
export const ScheduledPlugin = definePlugin()(() => ({
  name: "scheduled",
  options: {},
  server: () => import("./plugin.server.ts")
}));
