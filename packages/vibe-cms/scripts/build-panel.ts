/**
 * Builds the agency panel (apps/panel) and copies what `vibe-cms admin deploy` ships to Cloudflare into
 * `panel-dist/`: the Worker, the static client, and a manifest of what the panel's own build decided.
 */
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const here = import.meta.dir;
const panel = path.resolve(here, "../../../apps/panel");
const out = path.resolve(here, "../panel-dist");

const build = Bun.spawn(["bun", "run", "build"], { cwd: panel, stdout: "inherit", stderr: "inherit" });
if(await build.exited) process.exit(1);

const built = JSON.parse(await readFile(path.join(panel, "dist/vibe_panel/wrangler.json"), "utf8"));
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(panel, "dist/vibe_panel/index.js"), path.join(out, "index.js"));
await cp(path.join(panel, "dist/client"), path.join(out, "client"), { recursive: true });
await writeFile(path.join(out, "manifest.json"), `${JSON.stringify({
  compatibility_date: built.compatibility_date,
  compatibility_flags: built.compatibility_flags ?? [],
  run_worker_first: built.assets.run_worker_first,
  crons: built.triggers?.crons ?? []
}, null, 2)}\n`);
console.log(`Panel bundle written to ${out}`);
