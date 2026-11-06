import { BACKUP_TABLE_NAMES, BackupError, readSnapshot, type BackupManifest, type BackupStore, type SnapshotFile } from "./index.ts";

/**
 * `.vibe` files: one snapshot, media included, as a gzipped tar. `tar -xzf site.vibe` opens one.
 * Entries are in the order a restore needs them: `manifest.json` first, then the tables, the
 * file list, and the files under `files/`. Reading and writing both stream, in Bun, Node and
 * Workers alike, so a large site never has to fit in memory.
 */

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface Entry {
  name: string,
  size: number,
  body: ReadableStream<Uint8Array> | Uint8Array
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

/** A ustar header. Names longer than 100 bytes go in the 155-byte prefix, split at a `/`. */
function header(name: string, size: number): Uint8Array {
  let prefix = "";
  let base = name;
  if(encoder.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", 155);
    if(cut <= 0 || encoder.encode(name.slice(cut + 1)).length > 100) throw new BackupError(`"${name}" is too long for a .vibe entry`);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  const block = new Uint8Array(BLOCK);
  function put(text: string, offset: number) {
    return block.set(encoder.encode(text), offset);
  }
  put(base, 0);
  put(octal(0o644, 8), 100);
  put(octal(0, 8), 108);
  put(octal(0, 8), 116);
  put(octal(size, 12), 124);
  put(octal(Math.floor(Date.now() / 1000), 12), 136);
  put("        ", 148);
  put("0", 156);
  put("ustar\0", 257);
  put("00", 263);
  put(prefix, 345);
  const sum = block.reduce((total, byte) => total + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function padding(size: number): Uint8Array {
  return new Uint8Array((BLOCK - (size % BLOCK)) % BLOCK);
}

/** Writes entries as a gzipped tar stream. Each body must have exactly `size` bytes. */
function pack(entries: AsyncIterable<Entry>): ReadableStream<Uint8Array> {
  const tar = new TransformStream<Uint8Array, Uint8Array>();
  void (async () => {
    const writer = tar.writable.getWriter();
    try {
      for await (const entry of entries) {
        await writer.write(header(entry.name, entry.size));
        let written = 0;
        if(entry.body instanceof Uint8Array) {
          await writer.write(entry.body);
          written = entry.body.byteLength;
        } else {
          for await (const chunk of entry.body as unknown as AsyncIterable<Uint8Array>) {
            await writer.write(chunk);
            written += chunk.byteLength;
          }
        }
        if(written !== entry.size) throw new BackupError(`${entry.name} has ${written} bytes, not ${entry.size}`);
        await writer.write(padding(entry.size));
      }
      await writer.write(new Uint8Array(BLOCK * 2));
      await writer.close();
    } catch (error) {
      await writer.abort(error);
    }
  })();
  return tar.readable.pipeThrough(new CompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>);
}

/** Reads exact byte counts from a stream. */
class ByteReader {
  private buffer = new Uint8Array(0);
  private done = false;
  // Only `read()`: Bun, Node and Workers each type their stream readers with extra methods of their own.
  constructor(private readonly reader: { read(): Promise<{ done: false, value: Uint8Array } | { done: true, value?: Uint8Array }> }) {}

  private async fill(n: number): Promise<boolean> {
    while(this.buffer.length < n && !this.done) {
      const next = await this.reader.read().catch(() => {
        throw new BackupError("This isn't a .vibe file, or it's damaged (it doesn't decompress)");
      });
      if(next.done) {
        this.done = true;
      } else {
        const merged = new Uint8Array(this.buffer.length + next.value.length);
        merged.set(this.buffer);
        merged.set(next.value, this.buffer.length);
        this.buffer = merged;
      }
    }
    return this.buffer.length >= n;
  }

  async read(n: number): Promise<Uint8Array | null> {
    if(!(await this.fill(n))) return null;
    const out = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n);
    return out;
  }

  /** Up to `max` bytes, whatever is buffered or arrives next. */
  async chunk(max: number): Promise<Uint8Array | null> {
    if(!(await this.fill(1))) return null;
    const out = this.buffer.slice(0, Math.min(max, this.buffer.length));
    this.buffer = this.buffer.slice(out.length);
    return out;
  }
}

function text(block: Uint8Array, offset: number, length: number): string {
  const bytes = block.subarray(offset, offset + length);
  const end = bytes.indexOf(0);
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

/**
 * Reads a gzipped tar stream entry by entry. Each body streams; whatever a caller doesn't
 * read of one is skipped before the next.
 */
async function* unpack(stream: ReadableStream<Uint8Array>): AsyncGenerator<{ name: string, size: number, body: ReadableStream<Uint8Array> }> {
  const bytes = new ByteReader(stream.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>).getReader());
  for(let first = true; ; first = false) {
    const block = await bytes.read(BLOCK);
    if(!block && first) throw new BackupError("This isn't a .vibe file (it's too short to be one)");
    if(!block || block.every(byte => byte === 0)) return;
    if(text(block, 257, 5) !== "ustar") throw new BackupError("This isn't a .vibe file (not a tar archive)");
    const prefix = text(block, 345, 155);
    const name = prefix ? `${prefix}/${text(block, 0, 100)}` : text(block, 0, 100);
    const size = parseInt(text(block, 124, 12).trim() || "0", 8);
    const type = text(block, 156, 1);
    let left = size;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if(left === 0) {
          controller.close();
          return;
        }
        const chunk = await bytes.chunk(Math.min(left, 1 << 20));
        if(!chunk) {
          controller.error(new BackupError(`The .vibe file ends in the middle of ${name}`));
          return;
        }
        left -= chunk.length;
        controller.enqueue(chunk);
      }
    });
    // Directories and links carry nothing a snapshot uses.
    if(type === "0" || type === "") yield { name, size, body };
    while(left > 0) {
      const chunk = await bytes.chunk(Math.min(left, 1 << 20));
      if(!chunk) throw new BackupError(`The .vibe file ends in the middle of ${name}`);
      left -= chunk.length;
    }
    await bytes.read(padding(size).length);
  }
}

/** A snapshot in a store, as a `.vibe` stream: manifest first, files last. */
export async function packSnapshot(store: BackupStore, path: string): Promise<ReadableStream<Uint8Array>> {
  await readSnapshot(store, path);
  async function* entries(): AsyncGenerator<Entry> {
    async function small(name: string, from: string) {
      const value = await store.readText(from);
      if(value === null) throw new BackupError(`The snapshot is missing ${from}`);
      const body = encoder.encode(value);
      return { name, size: body.byteLength, body };
    }
    yield await small("manifest.json", `${path}/manifest.json`);
    yield await small("complete.json", `${path}/complete.json`);
    for(const table of BACKUP_TABLE_NAMES) yield await small(`tables/${table}.jsonl`, `${path}/tables/${table}.jsonl`);
    const files = await small("files.json", `${path}/files.json`);
    yield files;
    for(const file of JSON.parse(decoder.decode(files.body)) as SnapshotFile[]) {
      const stored = await store.readFile(file.object);
      if(!stored) throw new BackupError(`The snapshot's copy of ${file.key} is missing (${file.object})`);
      yield { name: file.object, size: stored.size, body: stored.body };
    }
  }
  return pack(entries());
}

/**
 * Writes a `.vibe` stream into a store as a snapshot, and returns its path. Files land at
 * the paths the snapshot's file list names, so restoring from the store works as usual.
 */
export async function unpackSnapshot(stream: ReadableStream<Uint8Array>, store: BackupStore): Promise<{ path: string, manifest: BackupManifest }> {
  let root: string | null = null;
  let manifest: BackupManifest | null = null;
  const objects = new Set<string>();
  let warnings: string[] = [];
  for await (const entry of unpack(stream)) {
    if(entry.name.includes("..") || entry.name.startsWith("/")) throw new BackupError(`Unsafe path in the .vibe file: ${entry.name}`);
    if(!root) {
      if(entry.name !== "manifest.json") throw new BackupError("This .vibe file doesn't start with manifest.json");
      const text = await new Response(entry.body).text();
      manifest = JSON.parse(text) as BackupManifest;
      root = `snapshots/${manifest.siteId}/${new Date(manifest.takenAt).toISOString().replace(/[:.]/g, "-")}`;
      await store.writeText(`${root}/manifest.json`, text);
      continue;
    }
    if(entry.name.startsWith("files/")) {
      if(!objects.has(entry.name)) throw new BackupError(`${entry.name} isn't in the .vibe file's file list`);
      if(!(await store.has(entry.name))) await store.writeFile(entry.name, entry.body, entry.size);
      continue;
    }
    const text = await new Response(entry.body).text();
    if(entry.name === "complete.json") {
      warnings = (JSON.parse(text) as { warnings?: string[] }).warnings ?? [];
      continue;
    }
    if(entry.name === "files.json") for(const file of JSON.parse(text) as SnapshotFile[]) objects.add(file.object);
    await store.writeText(`${root}/${entry.name}`, text);
  }
  if(!root || !manifest) throw new BackupError("This .vibe file is empty");
  for(const object of objects) {
    if(!(await store.has(object))) throw new BackupError(`The .vibe file is incomplete: ${object} is missing`);
  }
  // Last, as when the snapshot was taken: an interrupted import never looks finished.
  await store.writeText(`${root}/complete.json`, JSON.stringify({ completedAt: Date.now(), warnings }));
  return { path: root, manifest };
}
