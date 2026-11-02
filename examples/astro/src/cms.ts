import { createHandler } from "vibe-cms/handler";
import config from "../vibe-cms.config.ts";

// Hands the CMS its resources. The names on the left are fixed; the env bindings are yours (see wrangler.jsonc).
export const vibe = createHandler(config, {
  bindings: (env: Env) => ({ db: env.DB, storage: env.MEDIA })
});

export const { post } = config.schemas;
