import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { BackupStore } from "./index.ts";

/** Snapshots in a local folder, for the CLI. Writes go to a temporary file first, so nothing is ever half there. */
export function folderStore(root: string): BackupStore {
  function resolve(p: string) {
    const full = path.resolve(root, p);
    if(full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) throw new Error(`${p} is outside the backup folder`);
    return full;
  }
  async function atomically(target: string, write: (temp: string) => Promise<void>) {
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.part`;
    try {
      await write(temp);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }
  return {
    async readText(p) {
      return readFile(resolve(p), "utf8").catch(() => null);
    },
    writeText(p, text) {
      return atomically(resolve(p), temp => writeFile(temp, text));
    },
    async has(p) {
      return stat(resolve(p)).then(s => s.isFile(), () => false);
    },
    async readFile(p) {
      const file = resolve(p);
      const info = await stat(file).catch(() => null);
      if(!info?.isFile()) return null;
      return { body: Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>, size: info.size };
    },
    writeFile(p, body, size) {
      return atomically(resolve(p), async temp => {
        await pipeline(Readable.fromWeb(body as never), createWriteStream(temp));
        const written = (await stat(temp)).size;
        if(written !== size) throw new Error(`Expected ${size} bytes for ${p}, got ${written}`);
      });
    },
    async list(p) {
      return readdir(resolve(p)).catch(() => []);
    }
  };
}
