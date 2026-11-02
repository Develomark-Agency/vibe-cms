import { handle } from "@astrojs/cloudflare/handler";
import { vibe } from "./cms.ts";

// `/_vibe/*` goes to the CMS, everything else to Astro. The cron trigger runs scheduled publishing.
export default vibe({
  fetch: (request, env, ctx) => handle(request as never, env as never, ctx as never)
});
