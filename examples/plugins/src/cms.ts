import { createHandler } from "vibe-cms/handler";
import config from "../vibe-cms.config.ts";

export interface Env {
  DB: D1Database,
  MEDIA: R2Bucket,
  COUNTERS: DurableObjectNamespace<import("./counter/counter.server.ts").Counter>,
  WEBHOOK_URL: string
}

// Each plugin's binding contract is supplied under its name; a missing one is a type error.
export const vibe = createHandler(config, {
  bindings: (env: Env) => ({
    db: env.DB,
    storage: env.MEDIA,
    webhook: { url: env.WEBHOOK_URL },
    counter: { counters: env.COUNTERS }
  })
});
