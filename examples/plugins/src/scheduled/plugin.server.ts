import { defineServer } from "vibe-cms/server";
import config from "../../vibe-cms.config.ts";
import type { ScheduledPlugin } from "./index.ts";

const { post } = config.schemas;

export default defineServer<typeof ScheduledPlugin, typeof config>(({ cms, log }) => ({
  // Keyed by the cron expression, which must match a trigger on the Worker exactly.
  cron: {
    "0 * * * *": async () => {
      const [all, live] = await cms.batch([cms.query(post, { drafts: true }).count(), cms.query(post).count()]);
      log.info(`scheduled: ${all - live} posts never published`);
    }
  },
  // Keyed by queue name. A batch for a queue no plugin claims goes to your Worker's own `queue` handler.
  queues: {
    "post-events": async batch => {
      for(const message of batch.messages) log.info("scheduled: event", message.body);
    }
  }
}));
