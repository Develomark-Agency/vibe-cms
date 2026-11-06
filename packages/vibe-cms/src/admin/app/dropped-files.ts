/**
 * What was dropped from the desktop: files, and the files inside dropped folders with the folder
 * path they were in. Browsers only expose folders through `webkitGetAsEntry`, which has to be
 * called while the drop event is being handled, so `readDrop` takes its entries synchronously.
 */

export interface DroppedFile {
  file: File,
  /** The folder it was in, relative to the drop: `"trip/day 1"`, or null for a file dropped as is. */
  folder: string | null
}

export interface Dropped {
  files: DroppedFile[],
  /** Every dropped folder and subfolder, empty ones included, relative to the drop. */
  folders: string[]
}

/** Files the OS keeps in folders that nobody means to upload. */
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini", ".localized"]);

function ignored(name: string): boolean {
  return IGNORED.has(name) || name.startsWith("._");
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

/** All of a folder's entries: `readEntries` returns them in batches until an empty one. */
async function children(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  for(;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if(batch.length === 0) return all;
    all.push(...batch);
  }
}

async function walk(entry: FileSystemEntry, folder: string | null, out: Dropped): Promise<void> {
  if(ignored(entry.name)) return;
  if(entry.isFile) {
    out.files.push({ file: await fileOf(entry as FileSystemFileEntry), folder });
    return;
  }
  if(entry.isDirectory) {
    const path = folder ? `${folder}/${entry.name}` : entry.name;
    out.folders.push(path);
    for(const child of await children(entry as FileSystemDirectoryEntry)) await walk(child, path, out);
  }
}

/** Reads a drop's files and folders. Call it before the first `await` in the drop handler. */
export function readDrop(data: DataTransfer): Promise<Dropped> {
  // Entries have to be taken now: the DataTransfer is emptied once the event handler returns.
  const entries = Array.from(data.items)
    .filter(item => item.kind === "file")
    .map(item => item.webkitGetAsEntry?.() ?? null);
  const plain = Array.from(data.files);
  return (async () => {
    const out: Dropped = { files: [], folders: [] };
    // Browsers without entries: the files as they are (a folder can't be read there).
    if(entries.length === 0 || entries.some(entry => entry === null)) {
      out.files = plain.filter(file => !ignored(file.name)).map(file => ({ file, folder: null }));
      return out;
    }
    for(const entry of entries) await walk(entry!, null, out);
    return out;
  })();
}
