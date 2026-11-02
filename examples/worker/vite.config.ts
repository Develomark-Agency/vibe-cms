import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { vibe } from "vibe-cms/vite";

export default defineConfig({
  server: { port: 1340 },
  // vibe() serves the editor at /_vibe/admin in dev and builds it into the client output.
  plugins: [vibe(), cloudflare()]
});
