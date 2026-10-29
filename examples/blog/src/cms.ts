import { createHandler } from "vibe-cms/handler";
import config from "../vibe-cms.config.ts";

export const vibe = createHandler(config, {
  bindings: (env: Cloudflare.Env) => ({
    db: env.DB,
    storage: env.MEDIA,
    views: { counters: env.VIEW_COUNTERS }
  })
});
