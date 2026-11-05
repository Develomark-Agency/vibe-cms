import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Bundle, BundleManifest } from "./state.ts";

/** The prebuilt panel: `panel-dist/` in the package, made by `bun run build:panel` (and before publishing). */
export async function locateBundle(dir = fileURLToPath(new URL("../../../panel-dist", import.meta.url))): Promise<Bundle> {
  try {
    const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8")) as BundleManifest;
    await readFile(`${dir}/index.js`);
    return { dir, manifest };
  } catch {
    throw new Error(`The panel bundle isn't built (looked in ${dir}). In the vibe-cms repository, run \`bun run build:panel\` in packages/vibe-cms first.`);
  }
}
