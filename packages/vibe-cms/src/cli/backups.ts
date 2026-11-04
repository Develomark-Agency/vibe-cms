import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { styleText } from "node:util";
import { command, flag, option, optional, positional, string } from "cmd-ts";
import type { ActionCaller } from "../actions/client.ts";
import { httpCaller } from "../actions/client.ts";
import { folderStore } from "../backups/fs.ts";
import { BackupError, packSnapshot, planRestore, restoreSnapshot, takeSnapshot, unpackSnapshot, verifyRestore, type BackupManifest, type Progress } from "../backups/index.ts";
import { connection, siteToken } from "./actions.ts";

/** `vibe-cms export` and `vibe-cms import`: a site's content and media, as one `.vibe` file. */

function bytes(n: number): string {
  if(n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if(n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if(n >= 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

function reporter() {
  const tty = process.stderr.isTTY;
  return {
    progress(p: Progress) {
      let line: string;
      if(p.step === "table") line = `  ${p.table} ${p.rows}/${p.total}`;
      else if(p.step === "file") line = `  files ${p.done}/${p.total}`;
      else if(p.step === "commit") line = "  finishing";
      else {
        process.stderr.write(`${tty ? "\r\x1b[2K" : ""}${styleText("yellow", "↻")} ${p.what} failed (${p.error}); retry ${p.attempt}\n`);
        return;
      }
      if(tty) process.stderr.write(`\r\x1b[2K${line}`);
    },
    done() {
      if(tty) process.stderr.write("\r\x1b[2K");
    }
  };
}

async function caller(values: { site: string, token?: string, prefix: string }) {
  const token = await siteToken(values).catch((error: Error) => {
    console.error(`${styleText("red", "✗")} ${error.message}`);
    process.exit(1);
  });
  return httpCaller({ url: values.site, prefix: values.prefix, token });
}

function fail(error: unknown): never {
  if(error instanceof BackupError) {
    console.error(`${styleText("red", "✗")} ${error.message}`);
    const details = (error.details as { details?: { problems?: string[] } } | undefined)?.details;
    for(const problem of details?.problems ?? []) console.error(`  ${styleText("red", "•")} ${problem}`);
    process.exit(1);
  }
  throw error;
}

/** `ct-moving-storage-2026-11-02-1830.vibe`. */
function defaultName(manifest: BackupManifest, suffix = ""): string {
  const slug = (manifest.name ?? manifest.siteId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
  const at = new Date(manifest.takenAt);
  const stamp = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}-${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
  return `${slug}${suffix}-${stamp}.vibe`;
}

/** Takes a snapshot of the live site and writes it as one file. The temporary folder is gone either way. */
async function exportSite(call: ActionCaller, file: string | undefined, dir: string, onProgress: (p: Progress) => void, suffix?: string) {
  const work = await mkdtemp(path.join(tmpdir(), "vibe-export-"));
  try {
    const store = folderStore(work);
    const taken = await takeSnapshot({ call, store, onProgress });
    const target = path.resolve(dir, file ?? defaultName(taken.manifest, suffix));
    const partial = `${target}.part`;
    try {
      await pipeline(Readable.fromWeb((await packSnapshot(store, taken.path)) as never), createWriteStream(partial));
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
    await rename(partial, target);
    return { target, taken, size: (await stat(target)).size };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export const exportCommand = command({
  name: "export",
  description: "Save a site's content and media as one .vibe file",
  args: {
    ...connection,
    file: option({ long: "file", short: "f", type: optional(string), description: "Where to write it; defaults to <site>-<date>.vibe here" })
  },
  examples: [{ description: "Export a local site", command: "vibe-cms export --site http://localhost:4321" }],
  async handler(values) {
    const report = reporter();
    try {
      const { target, taken, size } = await exportSite(await caller(values), values.file, process.cwd(), report.progress);
      report.done();
      const { manifest } = taken;
      console.log(`${styleText("green", "✓")} ${styleText("bold", "Exported")} ${styleText("cyan", path.relative(process.cwd(), target) || target)} ${styleText("dim", `(${bytes(size)})`)}`);
      console.log(styleText("dim", `  ${manifest.tables.documents} documents, ${manifest.tables.versions} versions, ${manifest.files.count} files`));
      for(const warning of taken.warnings) console.log(`  ${styleText("yellow", "!")} ${warning}`);
    } catch (error) {
      report.done();
      fail(error);
    }
  }
});

export const importCommand = command({
  name: "import",
  description: "Replace a site's content and media with a .vibe file's",
  args: {
    ...connection,
    file: positional({ type: string, displayName: "file", description: "The .vibe file" }),
    dryRun: flag({ long: "dry-run", description: "Check the file against the site and show what would change, without changing it" }),
    yes: flag({ long: "yes", short: "y", description: "Don't ask before replacing the site's content" }),
    noSafety: flag({ long: "no-safety-export", description: "Skip exporting the site as it is before importing" }),
    force: flag({ long: "force", description: "Replace another unfinished import or restore" })
  },
  examples: [
    { description: "See what an import would change", command: "vibe-cms import ct-moving-2026-11-02-1830.vibe --site https://ctmoving.com --dry-run" },
    { description: "Move local content to production, after vibe-cms login", command: "vibe-cms import ct-moving-2026-11-02-1830.vibe --site https://ctmoving.com" }
  ],
  async handler(values) {
    const report = reporter();
    const work = await mkdtemp(path.join(tmpdir(), "vibe-import-"));
    try {
      const input = path.resolve(values.file);
      if(!(await stat(input).catch(() => null))?.isFile()) throw new BackupError(`No file at ${values.file}`);
      const store = folderStore(work);
      const { path: snapshot } = await unpackSnapshot(Readable.toWeb(createReadStream(input)) as unknown as ReadableStream<Uint8Array>, store);
      const call = await caller(values);
      const plan = await planRestore({ call, store, path: snapshot });
      console.log(`${styleText("bold", "Import")} ${values.file}`);
      console.log(styleText("dim", `  of ${plan.snapshot.name ?? plan.snapshot.siteId}, taken ${new Date(plan.snapshot.takenAt).toLocaleString()}, into ${values.site}`));
      for(const [name, { now, after }] of Object.entries(plan.tables)) console.log(`  ${name.padEnd(10)} ${String(now).padStart(6)} → ${after}`);
      console.log(`  ${"files".padEnd(10)} ${String(plan.files.now.count).padStart(6)} → ${plan.files.after.count} (${bytes(plan.files.after.bytes)})`);
      for(const warning of plan.check.warnings) console.log(`  ${styleText("yellow", "!")} ${warning}`);
      if(!plan.check.ok) throw new BackupError("This file can't be imported into this site", { details: { problems: plan.check.problems } });
      if(values.dryRun) return;
      if(!values.yes) {
        if(!process.stdin.isTTY) throw new BackupError("Pass --yes to import without a terminal to confirm in");
        const answer = prompt(`Replace ${values.site}'s content with this file's? [y/N]`);
        if(answer?.trim().toLowerCase() !== "y") return;
      }
      // An import that stopped part-way left the site as it was, and its export already exists.
      const status = await call("backups.restoreStatus", {}) as { restore: { from: { siteId: string, takenAt: number } } | null };
      const resuming = status.restore?.from.siteId === plan.snapshot.siteId && status.restore.from.takenAt === plan.snapshot.takenAt;
      if(!values.noSafety && !resuming) {
        const safety = await exportSite(call, undefined, path.dirname(input), report.progress, "-before-import");
        report.done();
        console.log(`${styleText("green", "✓")} Exported the site as it was first: ${styleText("cyan", path.relative(process.cwd(), safety.target) || safety.target)}`);
      }
      const result = await restoreSnapshot({ call, store, path: snapshot, force: values.force, onProgress: report.progress });
      report.done();
      const verified = await verifyRestore({ call, store, path: snapshot });
      console.log(`${styleText("green", "✓")} ${styleText("bold", "Imported")}${result.resumed ? " (resumed)" : ""}: ${result.files.uploaded} files uploaded, ${result.files.present} already there`);
      for(const warning of result.warnings) console.log(`  ${styleText("yellow", "!")} ${warning}`);
      if(!verified.ok) {
        console.log(`${styleText("yellow", "!")} The site doesn't match the file now (someone may have edited since):`);
        for(const difference of verified.differences) console.log(`  ${difference}`);
      }
    } catch (error) {
      report.done();
      fail(error);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
});
