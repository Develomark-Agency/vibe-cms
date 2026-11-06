/**
 * `bun run package [--destination <dir>]`: builds and packs the publishable tarball.
 *
 * In this repo, package.json's `exports` and `bin` point at `src` so the workspace runs on source with no build
 * step. The published package points them at the compiled `dist` instead. Rather than rewriting package.json in
 * place (and leaving it rewritten if anything fails), this copies the package into a staging directory, writes
 * the published package.json there, and packs that.
 *
 * Each export keeps a `source` condition pointing at `src`, which the editor's Vite build resolves (see
 * src/vite/index.ts), so the editor and site widgets share one copy of the modules they import.
 */
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { SOURCE_EXPORTS } from "./source-exports.ts";

const here = path.resolve(import.meta.dir, "..");
const { values } = parseArgs({ options: { destination: { type: "string", default: process.cwd() } } });
const destination = path.resolve(values.destination);

async function run(cmd: string[], cwd = here) {
  const proc = Bun.spawn(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if(await proc.exited) {
    console.error(`✗ ${cmd.join(" ")} failed`);
    process.exit(1);
  }
}

async function exists(file: string) {
  return stat(file).then(() => true, () => false);
}

await run(["bun", "scripts/build-panel.ts"]);
await run(["bunx", "tsdown"]);

const pkg = await Bun.file(path.join(here, "package.json")).json();

/** `./src/a/b.tsx` → `a/b`, the same path under dist without the extension. */
function distBase(source: string) {
  const match = /^\.\/src\/(.+)\.tsx?$/.exec(source);
  if(!match) throw new Error(`Expected a ./src/*.ts(x) path, got ${source}`);
  return match[1]!;
}

const exportsMap: Record<string, unknown> = {};
for(const [key, source] of Object.entries(pkg.exports as Record<string, string>)) {
  if(!/\.tsx?$/.test(source) || SOURCE_EXPORTS.has(key)) {
    // Stylesheets, and the exports in SOURCE_EXPORTS, are shipped as written.
    exportsMap[key] = source;
    continue;
  }
  const base = distBase(source);
  const entry = { source, types: `./dist/${base}.d.ts`, default: `./dist/${base}.js` };
  for(const file of [entry.types, entry.default]) {
    if(!await exists(path.join(here, file))) throw new Error(`${key}: tsdown didn't emit ${file}`);
  }
  exportsMap[key] = entry;
}

const bin = Object.fromEntries(Object.entries(pkg.bin as Record<string, string>).map(([name, source]) => [name, `./dist/${distBase(source)}.js`]));

// The published manifest: compiled entry points, and nothing that only matters in this repo.
const { scripts: _scripts, devDependencies: _devDependencies, ...rest } = pkg;
const published = { ...rest, bin, exports: exportsMap };

const stage = await mkdtemp(path.join(tmpdir(), "vibe-cms-pack-"));
try {
  for(const entry of [...pkg.files, "README.md"]) {
    const from = path.join(here, entry);
    if(!await exists(from)) throw new Error(`Missing ${entry}; did the build run?`);
    await cp(from, path.join(stage, entry), { recursive: true });
  }
  await Bun.write(path.join(stage, "package.json"), `${JSON.stringify(published, null, 2)}\n`);
  await run(["bun", "pm", "pack", "--destination", destination], stage);
} finally {
  await rm(stage, { recursive: true, force: true });
}
