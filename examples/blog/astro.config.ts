import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { vibe } from "vibe-cms/vite";

export default defineConfig({
  output: "server",
  // wrangler.jsonc is written by `alchemy dev` / `alchemy deploy` from alchemy.run.ts.
  // Images are served by vibe-cms from R2, so no Cloudflare Images binding.
  adapter: cloudflare({ configPath: "wrangler.jsonc", imageService: "passthrough" }),
  // React for blocks written as React components (src/components).
  integrations: [react()],
  server: { port: 1337 },
  vite: {
    plugins: [vibe()],
    server: { watch: { ignored: ["**/.alchemy/**"] } }
  }
});
