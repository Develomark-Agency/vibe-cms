import { vibe } from "./cms.ts";

// Durable Object classes declared by plugins (here, the counter's), re-exported by the vibe() Vite plugin.
export * from "vibe-cms/exports";

export default vibe({
  fetch: () => new Response("The site's own pages go here")
});
