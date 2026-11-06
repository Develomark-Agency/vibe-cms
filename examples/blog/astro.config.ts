import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import { existsSync } from "node:fs";
import { vibe } from "vibe-cms/vite";

// wrangler.jsonc is written by `alchemy dev` / `alchemy deploy` from alchemy.run.ts, with per-user
// resource names, so it isn't committed. `astro sync` (typecheck, CI) only needs types and runs without
// it; dev and build need its bindings and `main`, so they stop here rather than build the wrong Worker.
const wrangler = existsSync(new URL("./wrangler.jsonc", import.meta.url));
if(!wrangler && !process.argv.includes("sync")) {
  throw new Error("wrangler.jsonc is missing: run `bun run dev` or `bun run deploy`, which have Alchemy write it before starting Astro.");
}

export default defineConfig({
  output: "server",
  // Images are served by vibe-cms from R2, so no Cloudflare Images binding.
  adapter: cloudflare({ configPath: wrangler ? "wrangler.jsonc" : undefined, imageService: "passthrough" }),
  // React for blocks written as React components (src/components).
  integrations: [react()],
  server: { port: 1337 },
  vite: {
    plugins: [vibe()],
    server: { watch: { ignored: ["**/.alchemy/**"] } }
  }
});
