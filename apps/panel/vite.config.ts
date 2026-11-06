import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";

// The panel ships inside the vibe-cms package, so it reports that package's version.
const { version } = JSON.parse(readFileSync(new URL("../../packages/vibe-cms/package.json", import.meta.url), "utf8")) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
  define: { __VIBE_VERSION__: JSON.stringify(version) },
  build: { chunkSizeWarningLimit: 1000 }
});
