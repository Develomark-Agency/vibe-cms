import { handle } from "@astrojs/cloudflare/handler";
import { vibe } from "./cms.ts";

export * from "vibe-cms/exports";

// `/_vibe/*` goes to the CMS, everything else to Astro; cron runs scheduled publishing.
export default vibe({
  fetch: (request, env, ctx) => handle(request as never, env as never, ctx as never)
});
