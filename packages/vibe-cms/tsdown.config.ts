/**
 * Compiles `src` to `dist` for publishing: one `.js` and `.d.ts` per source module (unbundled), with
 * source maps back to `src`. Entries are the `exports` map and `bin` in package.json, which keep pointing
 * at `src` inside this repo; scripts/pack.ts rewrites them to `dist` in the packed package.json.
 *
 * `src` still ships alongside: the editor (src/admin/app) and the local panel (src/panel) are apps the
 * user's Vite builds from source, and the `source` export condition lets that build share one copy of
 * the modules it imports with any widget that imports `vibe-cms/admin/*`.
 */
import { defineConfig } from "tsdown";
import pkg from "./package.json" with { type: "json" };

const entry = [
  ...Object.values(pkg.exports).filter(file => /\.tsx?$/.test(file)),
  ...Object.values(pkg.bin)
];

export default defineConfig({
  entry,
  outDir: "dist",
  root: "src",
  unbundle: true,
  // Runs in Workers, browsers, Bun and Node: node builtins stay `node:` imports, nothing is polyfilled.
  platform: "neutral",
  target: "esnext",
  fixedExtension: false,
  sourcemap: true,
  dts: { sourcemap: true },
  clean: true,
  // Dependencies resolve from the user's node_modules; only our own modules are compiled.
  deps: { neverBundle: [/^node:/, /^vibe-cms(\/|$)/, /^virtual:/, /^cloudflare:/] },
  tsconfig: "tsconfig.json",
  inputOptions: {
    // Unbundled, every module is its own file, so "use client" stays at the top of the ones that have it.
    onLog(level, log, handler) {
      if(log.code !== "MODULE_LEVEL_DIRECTIVE") handler(level, log);
    }
  }
});
