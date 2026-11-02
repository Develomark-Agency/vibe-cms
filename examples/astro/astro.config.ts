import cloudflare from "@astrojs/cloudflare";
import { defineConfig } from "astro/config";
import { vibe } from "vibe-cms/vite";

export default defineConfig({
  output: "server",
  // The adapter reads wrangler.jsonc for bindings and builds `main` (src/worker.ts) as the Worker entry.
  // vibe-cms serves uploads from R2, so no Cloudflare Images binding.
  adapter: cloudflare({ configPath: "wrangler.jsonc", imageService: "passthrough" }),
  server: { port: 1342 },
  vite: { plugins: [vibe()] }
});
