import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { CollapsedPath } from "./collapsed-path.tsx";
import { StoredMetadata } from "./upload-metadata.tsx";
import { hasMetadataSupport } from "../../media/metadata.ts";
import { readDrop, type Dropped } from "./dropped-files.ts";
import {
  ChevronRightIcon,
  CopyIcon,
  CornerLeftUpIcon,
  FileIcon,
  FilmIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  LayoutGridIcon,
  ListTreeIcon,
  MoreHorizontalIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
  PencilIcon,
  SearchIcon,
  Trash2Icon,
  Undo2Icon,
  UploadIcon,
  XIcon
} from "lucide-react";
import { toast } from "sonner";
import { createContext, useContext, useEffect, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import type { MediaFolder } from "../../handler/engine.ts";
import type { Asset } from "../index.ts";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Input } from "../components/ui/input.tsx";
import { Kbd } from "../components/ui/kbd.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Toaster } from "../components/ui/sonner.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";
import { safe } from "@orpc/client";
import { ApiError } from "./client.ts";
import { formatDate, useAdmin } from "./context.tsx";
import { Delayed } from "./delayed.tsx";
import { UsageLink, staggerIndex, useDebounced } from "./pages.tsx";
import { AssetPreview, AssetThumb, describeAsset, formatBytes, useUpload } from "./pickers.tsx";
import { navigate, useLocation } from "./router.tsx";
import { Segmented } from "./segmented.tsx";
import { assetTextKind, TextEditorDialog, TextPreview } from "./text-file.tsx";

type View = "tree" | "grid";

/** Internal drags carry one of these; files from the desktop carry "Files". */
const ASSET_TYPE = "application/x-vibe-asset";
const FOLDER_TYPE = "application/x-vibe-folder";

function parentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function join(parent: string | null, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function isInside(path: string | null, folder: string): boolean {
  return path === folder || (path?.startsWith(`${folder}/`) ?? false);
}

function stored<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the choice just isn't remembered.
  }
}

// --- Feedback --------------------------------------------------------------------------

/** One step the user can take back. Kept in memory for the session, newest last. */
interface UndoEntry {
  /** "move", "rename", …: shown as "Undo move". */
  label: string,
  undo(): Promise<void>
}

const TOASTER = "media";

/** Media toasts sit at the bottom centre, apart from the editor's other notices, and can carry an Undo button. */
function notify(message: string, options: { type?: "success" | "error" | "info", undo?: () => void, description?: ReactNode } = {}) {
  const action = options.undo ? { label: "Undo", onClick: options.undo } : undefined;
  const show = options.type === "error" ? toast.error : options.type === "info" ? toast.info : options.type === "success" ? toast.success : toast;
  show(message, { toasterId: TOASTER, action, description: options.description, duration: options.undo ? 6000 : 4000 });
}

function quote(name: string): string {
  return `“${name.length > 40 ? `${name.slice(0, 39)}…` : name}”`;
}

const FOLDER_SVG = "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\"/></svg>";
const FILE_SVG = "<svg viewBox=\"0 0 24 24\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z\"/><path d=\"M14 2v4a2 2 0 0 0 2 2h4\"/></svg>";

/**
 * A compact chip as the drag image: what's being dragged, by name. Without it
 * the browser snapshots the dragged row, and inside the page's view-transition
 * layer that snapshot can pick up a large, offset slice of the screen.
 */
function setDragPreview(event: DragEvent, items: Item[]) {
  const names = items.map(item => (item.kind === "file" ? item.asset.filename : nameOf(item.path)));
  let label = names.join(", ");
  if(label.length > 48) label = `${label.slice(0, 47).trimEnd()}…`;
  const chip = document.createElement("div");
  chip.className = "fixed top-0 left-[-9999px] z-50 flex max-w-96 items-center gap-2 rounded-[12px] floating px-3 py-2 text-sm font-medium text-popover-foreground";
  const icon = document.createElement("span");
  icon.className = "shrink-0 text-muted-foreground";
  icon.innerHTML = items.every(item => item.kind === "folder") ? FOLDER_SVG : FILE_SVG;
  const text = document.createElement("span");
  text.className = "truncate";
  text.textContent = label;
  chip.append(icon, text);
  if(items.length > 1) {
    const count = document.createElement("span");
    count.className = "ml-1 shrink-0 rounded-full bg-foreground px-1.5 text-[11px] leading-5 text-background tabular-nums";
    count.textContent = String(items.length);
    chip.append(count);
  }
  document.body.appendChild(chip);
  event.dataTransfer.setDragImage(chip, 14, 14);
  setTimeout(() => chip.remove());
}

// --- Selection -------------------------------------------------------------------------

/** Something in the browser that can be selected. */
type Item = { kind: "file", asset: Asset } | { kind: "folder", path: string };

/** What bulk actions act on; also what a multi-item drag carries. */
interface Bulk {
  files: Array<{ id: string, folder: string | null, size: number, name: string }>,
  folders: string[]
}

const ITEMS_TYPE = "application/x-vibe-items";

function itemKey(item: Item): string {
  return item.kind === "file" ? `f:${item.asset.id}` : `d:${item.path}`;
}

function toBulk(items: Iterable<Item>): Bulk {
  const bulk: Bulk = { files: [], folders: [] };
  for(const item of items) {
    if(item.kind === "file") bulk.files.push({ id: item.asset.id, folder: item.asset.folder, size: item.asset.size, name: item.asset.filename });
    else bulk.folders.push(item.path);
  }
  return bulk;
}

function bulkLabel(bulk: Bulk): string {
  const count = bulk.files.length + bulk.folders.length;
  if(count === 1) return bulk.files[0]?.name ?? nameOf(bulk.folders[0]!);
  return `${count} items`;
}

/**
 * Finder-style: a plain click picks one thing (and previews it), ⌘/Ctrl-click
 * toggles, Shift-click takes the range from the last click in on-screen order.
 * "Multi" is on once the selection was built with modifiers or checkboxes.
 */
interface Selection {
  picked: Map<string, Item>,
  multi: boolean,
  has(item: Item): boolean,
  click(item: Item, event: MouseEvent, plain: () => void): void,
  toggle(item: Item): void,
  register(item: Item): void,
  drag(item: Item): { draggable?: boolean, onDragStart?(event: DragEvent): void }
}

const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection {
  return useContext(SelectionContext)!;
}

/** Registers the item for range selection and returns what its row needs. */
function usePick(item: Item) {
  const selection = useSelection();
  selection.register(item);
  return { key: itemKey(item), picked: selection.multi && selection.has(item), selection };
}

/** Shown on hover, and always while selecting. 6px in from a 14px thumbnail corner or inside a row. */
function PickBox({ item, className }: { item: Item, className?: string }) {
  const selection = useSelection();
  const name = item.kind === "file" ? item.asset.filename : nameOf(item.path);
  return (
    <Checkbox
      checked={selection.multi && selection.has(item)}
      onCheckedChange={() => selection.toggle(item)}
      onClick={event => event.stopPropagation()}
      aria-label={`Select ${name}`}
      className={cn("transition-opacity duration-150 after:inset-0", !selection.multi && "opacity-0 group-hover/pick:opacity-100 focus-visible:opacity-100", className)}
    />
  );
}

/** What the media page needs to know about the folder tree, plus the actions that change it. */
function useLibrary() {
  const { cms, session } = useAdmin();
  const queryClient = useQueryClient();
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => cms.actions.folders.list() });
  const all = folders.data?.folders ?? [];

  function childrenOf(parent: string | null): MediaFolder[] {
    return all.filter(f => parentOf(f.path) === parent);
  }

  function itemCount(path: string): number {
    return (all.find(f => f.path === path)?.files ?? 0) + childrenOf(path).length;
  }

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    void queryClient.invalidateQueries({ queryKey: ["asset-detail"] });
    void queryClient.invalidateQueries({ queryKey: ["asset"] });
    void queryClient.invalidateQueries({ queryKey: ["trash"] });
  }

  async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | null> {
    try {
      const result = await action();
      if(success) notify(success, { type: "success" });
      return result;
    } catch (error) {
      notify(error instanceof ApiError ? error.message : "Something went wrong", { type: "error" });
      return null;
    } finally {
      refresh();
    }
  }

  return {
    folders: all,
    loading: folders.isLoading,
    canWrite: session.permissions.media.write,
    canDelete: session.permissions.media.delete,
    childrenOf,
    itemCount,
    refresh,
    createFolder: (path: string) => attempt(() => cms.actions.folders.create({ path })),
    moveFolder: (from: string, to: string) => attempt(() => cms.actions.folders.move({ from, to })),
    deleteFolder: (path: string) => attempt(() => cms.actions.folders.delete({ path }), "Folder deleted"),
    moveAsset: (id: string, folder: string | null) => attempt(() => cms.actions.assets.update({ id, folder })),
    renameAsset: (id: string, filename: string) => attempt(() => cms.actions.assets.update({ id, filename })),
    deleteAsset: (id: string) => attempt(() => cms.actions.assets.delete({ id }))
  };
}

type Library = ReturnType<typeof useLibrary>;

function useFolderFiles(folder: string | null, enabled = true) {
  const { cms } = useAdmin();
  return useQuery({
    queryKey: ["assets", { folder: folder ?? "" }],
    enabled,
    queryFn: () => cms.assets.list({ folder: folder ?? "", limit: 200 }),
    placeholderData: keepPreviousData
  });
}

type Dialogs =
  | { kind: "new-folder", parent: string | null }
  | { kind: "rename-folder", path: string }
  | { kind: "move", bulk: Bulk }
  | { kind: "delete", bulk: Bulk };

export function MediaPage() {
  const { cms, site } = useAdmin();
  const library = useLibrary();
  const { search: params } = useLocation();
  const folder = params.get("folder") || null;
  const selected = params.get("file");
  const [view, setView] = useState<View>(() => stored("vibe:media-view", "tree", ["tree", "grid"] as const));
  const [paneOpen, setPaneOpen] = useState(() => stored("vibe:media-preview", "open", ["open", "closed"] as const) === "open");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState<Dialogs | null>(null);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [dragging, setDragging] = useState(false);
  // Every folder an upload of folders brought in, so the tree shows what arrived, not just the top level.
  const [revealed, setRevealed] = useState<string[]>([]);
  const [picked, setPicked] = useState<Map<string, Item>>(() => new Map());
  const [multi, setMulti] = useState(false);
  const anchor = useRef<string | null>(null);
  const registry = useRef(new Map<string, Item>());
  const browser = useRef<HTMLDivElement>(null);
  const [history, setHistory] = useState<UndoEntry[]>([]);
  const { uploadFiles, uploading } = useUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const query = useDebounced(search);
  const results = useQuery({
    queryKey: ["assets", { search: query }],
    enabled: query.length > 0,
    queryFn: () => cms.assets.list({ search: query, limit: 200 }),
    placeholderData: keepPreviousData
  });

  useEffect(() => {
    document.title = `Media · ${site.name}`;
  }, [site.name]);

  function record(entry: UndoEntry): () => void {
    setHistory(prev => [...prev.slice(-19), entry]);
    return () => void undo(entry);
  }

  /** Undoes `entry` (the newest step by default) and drops it from the history. */
  async function undo(entry?: UndoEntry) {
    const target = entry ?? history.at(-1);
    if(!target) {
      notify("Nothing to undo", { type: "info" });
      return;
    }
    setHistory(prev => prev.filter(e => e !== target));
    try {
      await target.undo();
      notify(`Undid ${target.label}`);
    } catch (error) {
      notify(error instanceof ApiError ? `Couldn't undo: ${error.message}` : "Couldn't undo", { type: "error" });
    } finally {
      library.refresh();
    }
  }

  function clearSelection() {
    setPicked(new Map());
    setMulti(false);
  }

  // What's on screen changes wholesale: start over. (The tree keeps its selection as folders open and close.)
  useEffect(clearSelection, [view, view === "grid" ? folder : null, query]);

  function visibleKeys(): string[] {
    return [...(browser.current?.querySelectorAll<HTMLElement>("[data-pick]") ?? [])].map(el => el.dataset.pick!);
  }

  function toggleItem(item: Item) {
    const key = itemKey(item);
    const next = new Map(picked);
    if(next.has(key)) next.delete(key);
    else next.set(key, item);
    anchor.current = key;
    setPicked(next);
    setMulti(next.size > 0);
  }

  const selection: Selection = {
    picked,
    multi,
    has: item => picked.has(itemKey(item)),
    register(item) {
      registry.current.set(itemKey(item), item);
    },
    click(item, event, plain) {
      const key = itemKey(item);
      if(event.shiftKey && anchor.current) {
        const keys = visibleKeys();
        const from = keys.indexOf(anchor.current);
        const to = keys.indexOf(key);
        if(from !== -1 && to !== -1) {
          event.preventDefault();
          const next = new Map(event.metaKey || event.ctrlKey ? picked : []);
          for(const k of keys.slice(Math.min(from, to), Math.max(from, to) + 1)) {
            const found = registry.current.get(k);
            if(found) next.set(k, found);
          }
          setPicked(next);
          setMulti(true);
          return;
        }
      }
      if(event.metaKey || event.ctrlKey) {
        event.preventDefault();
        toggleItem(item);
        return;
      }
      anchor.current = key;
      setPicked(item.kind === "file" ? new Map([[key, item]]) : new Map());
      setMulti(false);
      plain();
    },
    toggle: toggleItem,
    drag(item) {
      if(!library.canWrite) return {};
      return {
        draggable: true,
        onDragStart(event) {
          event.stopPropagation();
          const key = itemKey(item);
          const items = multi && picked.has(key) ? [...picked.values()] : [item];
          // Always the full description, so a drop knows where things came from (for undo).
          event.dataTransfer.setData(ITEMS_TYPE, JSON.stringify(toBulk(items)));
          event.dataTransfer.effectAllowed = "move";
          setDragPreview(event, items);
        }
      };
    }
  };

  /** Moves files and folders into `target`. Things already there, or inside a moved folder, ride along or stay put. */
  async function bulkMove(bulk: Bulk, target: string | null) {
    const folders = bulk.folders
      .filter(path => !bulk.folders.some(other => other !== path && isInside(path, other)))
      .filter(path => !(target !== null && isInside(target, path)) && parentOf(path) !== target);
    const files = bulk.files.filter(f => f.folder !== target && !bulk.folders.some(path => isInside(f.folder, path)));
    if(files.length + folders.length === 0) return;
    const movedFiles: Array<{ id: string, from: string | null, name: string }> = [];
    const movedFolders: Array<{ from: string, to: string }> = [];
    const errors: string[] = [];
    let nextFolder = folder;
    for(const file of files) {
      try {
        await cms.actions.assets.update({ id: file.id, folder: target });
        movedFiles.push({ id: file.id, from: file.folder, name: file.name });
      } catch (error) {
        errors.push(error instanceof ApiError ? error.message : `Couldn't move ${file.name}`);
      }
    }
    for(const path of folders) {
      try {
        const result = await cms.actions.folders.move({ from: path, to: join(target, nameOf(path)) });
        movedFolders.push({ from: path, to: result.path });
        if(isInside(folder, path)) nextFolder = result.path + folder!.slice(path.length);
      } catch (error) {
        errors.push(error instanceof ApiError ? error.message : `Couldn't move ${nameOf(path)}`);
      }
    }
    library.refresh();
    clearSelection();
    if(nextFolder !== folder) go({ folder: nextFolder });
    const moved = movedFiles.length + movedFolders.length;
    if(moved === 0) {
      notify(errors[0]!, { type: "error" });
      return;
    }
    const undoMove = record({
      label: "move",
      async undo() {
        // Folders first (newest first), so files go back into folders that are where they were.
        for(const f of [...movedFolders].reverse()) await cms.actions.folders.move({ from: f.to, to: f.from });
        for(const f of movedFiles) await cms.actions.assets.update({ id: f.id, folder: f.from });
      }
    });
    const what = moved === 1 ? quote(movedFiles[0]?.name ?? nameOf(movedFolders[0]!.from)) : `${moved} items`;
    const where = target ? nameOf(target) : "All files";
    if(errors.length) notify(`Moved ${what} to ${where}; ${errors.length} couldn't move: ${errors[0]}`, { type: "error", undo: undoMove });
    else notify(`Moved ${what} to ${where}`, { type: "success", undo: undoMove });
  }

  /** Files first, then folders deepest first, so a folder emptied by the same action can go too. */
  async function bulkDelete(bulk: Bulk) {
    const trashed: string[] = [];
    const removedFolders: string[] = [];
    let name = "";
    let deleted = 0;
    let inUse = 0;
    let notEmpty = 0;
    let failed = 0;
    for(const file of bulk.files) {
      const { data, error, definedError } = await safe(cms.actions.assets.delete({ id: file.id }));
      if(error) {
        if(definedError?.code === "CONFLICT") inUse++;
        else failed++;
        continue;
      }
      trashed.push(data.trash);
      name = file.name;
      deleted++;
    }
    for(const path of [...bulk.folders].sort((a, b) => b.split("/").length - a.split("/").length)) {
      const { error, definedError } = await safe(cms.actions.folders.delete({ path }));
      if(error) {
        if(definedError?.code === "CONFLICT") notEmpty++;
        else failed++;
        continue;
      }
      removedFolders.push(path);
      deleted++;
    }
    library.refresh();
    clearSelection();
    const gone = new Set(bulk.files.map(f => f.id));
    if(selected && gone.has(selected)) go({ file: null });
    const removedFolder = bulk.folders.find(path => isInside(folder, path));
    if(removedFolder && notEmpty === 0) go({ folder: parentOf(removedFolder), file: null });
    const kept = [
      inUse && `${inUse} ${inUse === 1 ? "file" : "files"} used by documents`,
      notEmpty && `${notEmpty} non-empty ${notEmpty === 1 ? "folder" : "folders"}`
    ].filter(Boolean);
    const what = deleted === 1 && trashed.length === 1 ? quote(name) : `${deleted} ${deleted === 1 ? "item" : "items"}`;
    const summary = `Moved ${what} to the trash${kept.length ? `, kept ${kept.join(" and ")}` : ""}${failed ? ` (${failed} failed)` : ""}`;
    const undoDelete = deleted > 0 ? record({
      label: "delete",
      async undo() {
        // Empty folders aren't trashed, just recreated; files come back from the trash into their folders.
        for(const path of removedFolders) await cms.actions.folders.create({ path });
        for(const id of trashed) await cms.actions.trash.restore({ id });
      }
    }) : undefined;
    notify(summary, { type: failed ? "error" : kept.length ? "info" : "success", undo: undoDelete });
  }

  // ⌘A selects what's visible, Escape clears, Delete asks to delete the selection.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if(dialog || editing || target?.closest("input, textarea, [contenteditable], [role=dialog], [role=menu]")) return;
      if((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void undo();
      } else if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const next = new Map<string, Item>();
        for(const key of visibleKeys()) {
          const found = registry.current.get(key);
          if(found) next.set(key, found);
        }
        setPicked(next);
        setMulti(next.size > 0);
      } else if(event.key === "Escape" && multi) {
        clearSelection();
      } else if((event.key === "Delete" || event.key === "Backspace") && multi && picked.size > 0 && library.canDelete) {
        event.preventDefault();
        setDialog({ kind: "delete", bulk: toBulk(picked.values()) });
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  function go(next: { folder?: string | null, file?: string | null }) {
    const url = new URLSearchParams();
    const nextFolder = next.folder === undefined ? folder : next.folder;
    const nextFile = next.file === undefined ? selected : next.file;
    if(nextFolder) url.set("folder", nextFolder);
    if(nextFile) url.set("file", nextFile);
    const qs = url.toString();
    navigate(`/media${qs ? `?${qs}` : ""}`, { replace: true });
  }

  function select(id: string) {
    go({ file: id });
    if(!paneOpen) togglePane(true);
  }

  function togglePane(open = !paneOpen) {
    setPaneOpen(open);
    store("vibe:media-preview", open ? "open" : "closed");
  }

  async function uploadInto(target: string | null, files: FileList | File[] | Dropped) {
    const dropped: Dropped = Array.isArray(files) || files instanceof FileList
      ? { files: Array.from(files).map(file => ({ file, folder: null })), folders: [] }
      : files;
    // Folders that didn't exist before this drop: undo removes them again.
    const existing = new Set(library.folders.map(f => f.path));
    const created = dropped.folders.map(path => join(target, path)).filter(path => !existing.has(path));
    // Every dropped folder, so empty ones arrive too; uploads make the rest. Not until the upload is confirmed.
    async function makeFolders() {
      for(const path of dropped.folders) await library.createFolder(join(target, path));
    }
    // Uploading folders always asks first, listing what's in them.
    const topFolders = dropped.folders.filter(path => !path.includes("/"));
    const uploaded = await uploadFiles(dropped.files, { folder: target ?? undefined }, makeFolders, topFolders);
    if(uploaded === null) return;
    // Uploads into new subfolders add them to the tree, opened.
    if(dropped.folders.length) {
      library.refresh();
      setRevealed(dropped.folders.map(path => join(target, path)));
    }
    const last = uploaded.at(-1);
    // A single dropped folder opens; otherwise the target does, at the last file.
    const top = dropped.folders.filter(path => !path.includes("/"));
    const singleFolder = top.length === 1 && dropped.files.every(f => f.folder) ? join(target, top[0]!) : null;
    if(!last) {
      if(singleFolder) go({ folder: singleFolder, file: null });
      return;
    }
    go(singleFolder ? { folder: singleFolder, file: null } : { folder: target, file: last.id });
    const undoUpload = record({
      label: uploaded.length === 1 ? "upload" : "uploads",
      async undo() {
        // An undone upload never happened, so it skips the trash.
        for(const asset of uploaded) {
          const { trash } = await cms.actions.assets.delete({ id: asset.id });
          await cms.actions.trash.purge({ id: trash });
        }
        // Deepest first; each is empty once its files are gone.
        for(const path of [...created].sort((a, b) => b.length - a.length)) await cms.actions.folders.delete({ path }).catch(() => {});
        library.refresh();
        go(singleFolder ? { folder: target, file: null } : { file: null });
      }
    });
    // A short headline, with the long parts (file names, what was removed) underneath on their own lines.
    const cleaned = uploaded.filter(asset => asset.meta.metadataRemoved).length;
    const into = target ? nameOf(target) : "All files";
    const headline = singleFolder
      ? `Uploaded ${quote(nameOf(singleFolder))}`
      : uploaded.length === 1 ? `Uploaded to ${into}` : `Uploaded ${uploaded.length} files to ${into}`;
    const removed = cleaned === 0 ? null : uploaded.length === 1 ? "Location and camera details removed" : `Details removed from ${cleaned} of ${uploaded.length}`;
    notify(headline, {
      type: "success",
      undo: undoUpload,
      description: (
        <span className="flex min-w-0 flex-col">
          {singleFolder && <span>{uploaded.length === 1 ? "1 file" : `${uploaded.length} files`} to {into}</span>}
          {!singleFolder && uploaded.length === 1 && <span className="truncate" title={last.filename}>{last.filename}</span>}
          {removed && <span>{removed}</span>}
        </span>
      )
    });
  }

  async function renameFile(asset: Asset, filename: string) {
    const renamed = await library.renameAsset(asset.id, filename);
    if(!renamed) return;
    const undoRename = record({
      label: "rename",
      undo: async () => {
        await cms.actions.assets.update({ id: asset.id, filename: asset.filename });
      }
    });
    notify(`Renamed to ${quote(renamed.filename)}`, { type: "success", undo: undoRename });
  }

  /** Drops onto a folder (or the root, null): desktop files upload into it, files and folders move into it. */
  async function dropInto(target: string | null, event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    // Read now: a dropped folder's contents are only reachable while the event is being handled.
    const desktop = event.dataTransfer.types.includes("Files") ? readDrop(event.dataTransfer) : null;
    const items = event.dataTransfer.getData(ITEMS_TYPE);
    const assetId = event.dataTransfer.getData(ASSET_TYPE);
    const folderPath = event.dataTransfer.getData(FOLDER_TYPE);
    if(items) {
      await bulkMove(JSON.parse(items) as Bulk, target);
    } else if(assetId || folderPath) {
      // From an older drag source: look up where the file was so the move can be undone.
      const known = assetId ? registry.current.get(`f:${assetId}`) : undefined;
      const file = known?.kind === "file" ? known.asset : assetId ? await cms.assets.get(assetId) : null;
      await bulkMove({ files: file ? [{ id: file.id, folder: file.folder, size: file.size, name: file.filename }] : [], folders: folderPath ? [folderPath] : [] }, target);
    } else if(desktop && library.canWrite) {
      await uploadInto(target, await desktop);
    }
  }

  const actions: FolderActions = {
    open: path => go({ folder: path, file: null }),
    // Double-click: text files open in the editor.
    openFile(asset) {
      if(assetTextKind(asset) && library.canWrite) setEditing(asset);
    },
    newFolder: parent => setDialog({ kind: "new-folder", parent }),
    rename: path => setDialog({ kind: "rename-folder", path }),
    move: path => setDialog({ kind: "move", bulk: { files: [], folders: [path] } }),
    async remove(path) {
      if(await library.deleteFolder(path) && isInside(folder, path)) go({ folder: parentOf(path) });
    },
    dropInto
  };

  const searching = query.length > 0;

  return (
    <div
      className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-5 px-4 py-6 md:px-8"
      // Capture: folders and the list stop the event, and while one of them is highlighted this outline steps aside.
      onDragOverCapture={event => {
        if(!library.canWrite || !event.dataTransfer.types.includes("Files")) return;
        setDragging(!(event.target as Element).closest?.("[data-drop-target]"));
      }}
      onDragOver={event => {
        if(!library.canWrite || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
      }}
      onDragLeave={event => event.currentTarget === event.target && setDragging(false)}
      onDrop={event => void dropInto(folder, event)}
    >
      {/* The breadcrumb gets its own line so the toolbar doesn't jump as paths get longer. */}
      <header className="flex flex-col gap-2 pt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-medium tracking-[-0.03em]">Media</h1>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all files" className="w-48 pl-8" />
            </div>
            <Segmented<View>
              label="View"
              value={view}
              onChange={next => {
                setView(next);
                store("vibe:media-view", next);
              }}
              options={[
                { value: "tree", label: <><ListTreeIcon className="size-4" /> Tree</> },
                { value: "grid", label: <><LayoutGridIcon className="size-4" /> Folders</> }
              ]}
            />
            {library.canWrite && (
              <>
                <Tooltip>
                  <TooltipTrigger render={
                    <Button variant="ghost" size="icon" aria-label={history.length ? `Undo ${history.at(-1)!.label}` : "Nothing to undo"} disabled={history.length === 0} onClick={() => void undo()}>
                      <Undo2Icon />
                    </Button>
                  } />
                  <TooltipContent>{history.length ? <>Undo {history.at(-1)!.label} <Kbd>⌘Z</Kbd></> : "Nothing to undo"}</TooltipContent>
                </Tooltip>
                <Button variant="outline" onClick={() => setDialog({ kind: "new-folder", parent: folder })}><FolderPlusIcon /> New folder</Button>
                <input ref={fileInput} type="file" multiple hidden onChange={e => {
                  if(e.target.files) void uploadInto(folder, e.target.files);
                  e.target.value = "";
                }} />
                <Button onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? <Spinner /> : <UploadIcon />} Upload</Button>
              </>
            )}
            <Tooltip>
              <TooltipTrigger render={
                <Button variant="ghost" size="icon" aria-label={paneOpen ? "Hide preview" : "Show preview"} aria-pressed={paneOpen} onClick={() => togglePane()} className="hidden lg:inline-flex">
                  {paneOpen ? <PanelRightCloseIcon /> : <PanelRightOpenIcon />}
                </Button>
              } />
              <TooltipContent>{paneOpen ? "Hide preview" : "Show preview"}</TooltipContent>
            </Tooltip>
          </div>
        </div>
        <Breadcrumb folder={folder} onOpen={path => go({ folder: path, file: null })} onDrop={dropInto} />
      </header>

      <SelectionContext.Provider value={selection}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
          <div ref={browser} className={cn("relative min-w-0 flex-1", dragging && "[&_[data-drop-area]]:drop-glow")}>
            {searching ? (
              <SearchResults loading={results.isLoading} assets={results.data?.assets} selected={selected} onSelect={id => select(id)} query={query} />
            ) : view === "tree" ? (
              <TreeView library={library} folder={folder} reveal={revealed} selected={selected} onSelect={(id, inFolder) => go({ folder: inFolder, file: id })} actions={actions} />
            ) : (
              <GridView library={library} folder={folder} selected={selected} onSelect={id => select(id)} actions={actions} />
            )}
            {library.canWrite && <p className="mt-3 text-xs text-muted-foreground">Drop files anywhere to upload them{folder ? ` into ${nameOf(folder)}` : ""}. Drag files and folders onto a folder to move them. ⌘-click or Shift-click to select several.</p>}
            {multi && picked.size > 0 && (
              <SelectionBar
                bulk={toBulk(picked.values())}
                canWrite={library.canWrite}
                canDelete={library.canDelete}
                onMove={() => setDialog({ kind: "move", bulk: toBulk(picked.values()) })}
                onDelete={() => setDialog({ kind: "delete", bulk: toBulk(picked.values()) })}
                onClear={clearSelection}
              />
            )}
          </div>
          {paneOpen && (
            <aside className="w-full shrink-0 lg:sticky lg:top-16 lg:w-80">
              {multi && picked.size > 0 ? <SelectionSummary items={[...picked.values()]} /> : <PreviewPane
                id={selected}
                folder={folder}
                library={library}
                onMove={asset => setDialog({ kind: "move", bulk: toBulk([{ kind: "file", asset }]) })}
                onEdit={asset => setEditing(asset)}
                onRename={(asset, filename) => renameFile(asset, filename)}
                onDeleted={(asset, trash) => {
                  go({ file: null });
                  const undoDelete = record({
                    label: "delete",
                    async undo() {
                      await cms.actions.trash.restore({ id: trash });
                      go({ file: asset.id });
                    }
                  });
                  notify(`Moved ${quote(asset.filename)} to the trash`, { type: "success", undo: undoDelete });
                }}
                onOpenFolder={path => go({ folder: path })}
              />}
            </aside>
          )}
        </div>
      </SelectionContext.Provider>

      <FolderNameDialog
        open={dialog?.kind === "new-folder" || dialog?.kind === "rename-folder"}
        title={dialog?.kind === "rename-folder" ? "Rename folder" : "New folder"}
        description={dialog?.kind === "new-folder" ? <span className="flex min-w-0 gap-1"><span className="shrink-0">In</span><FolderPath path={dialog.parent} /></span> : undefined}
        initial={dialog?.kind === "rename-folder" ? nameOf(dialog.path) : ""}
        submitLabel={dialog?.kind === "rename-folder" ? "Rename" : "Create"}
        onOpenChange={open => !open && setDialog(null)}
        onSubmit={async name => {
          if(dialog?.kind === "new-folder") {
            const created = await library.createFolder(join(dialog.parent, name));
            if(created) {
              go({ folder: created.path, file: null });
              const undoCreate = record({
                label: "new folder",
                async undo() {
                  await cms.actions.folders.delete({ path: created.path });
                  go({ folder: parentOf(created.path) });
                }
              });
              notify(`Created ${quote(nameOf(created.path))}`, { type: "success", undo: undoCreate });
            }
          } else if(dialog?.kind === "rename-folder") {
            const from = dialog.path;
            const moved = await library.moveFolder(from, join(parentOf(from), name));
            if(moved) {
              if(isInside(folder, from)) go({ folder: moved.path + folder!.slice(from.length) });
              const undoRename = record({
                label: "rename",
                undo: async () => {
                  await cms.actions.folders.move({ from: moved.path, to: from });
                }
              });
              notify(`Renamed to ${quote(nameOf(moved.path))}`, { type: "success", undo: undoRename });
            }
          }
          setDialog(null);
        }}
      />
      {editing && <TextEditorDialog asset={editing} open onOpenChange={open => !open && setEditing(null)} />}
      <MoveDialog
        library={library}
        bulk={dialog?.kind === "move" ? dialog.bulk : null}
        onOpenChange={open => !open && setDialog(null)}
        onMove={async target => {
          if(dialog?.kind === "move") await bulkMove(dialog.bulk, target);
          setDialog(null);
        }}
      />
      <Toaster id={TOASTER} position="bottom-center" />
      <DeleteDialog
        bulk={dialog?.kind === "delete" ? dialog.bulk : null}
        onOpenChange={open => !open && setDialog(null)}
        onDelete={async () => {
          if(dialog?.kind === "delete") await bulkDelete(dialog.bulk);
          setDialog(null);
        }}
      />
    </div>
  );
}

interface FolderActions {
  open(path: string | null): void,
  openFile(asset: Asset): void,
  newFolder(parent: string): void,
  rename(path: string): void,
  move(path: string): void,
  remove(path: string): void,
  dropInto(target: string | null, event: DragEvent): Promise<void>
}

/** Highlights while something droppable is over it. */
function useDropTarget(target: string | null, onDrop: FolderActions["dropInto"], enabled: boolean) {
  const [over, setOver] = useState(false);
  if(!enabled) return { over: false, props: {} };
  return {
    over,
    props: {
      "data-drop-target": "",
      onDragOver(event: DragEvent) {
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = event.dataTransfer.types.includes("Files") ? "copy" : "move";
        setOver(true);
      },
      onDragLeave(event: DragEvent) {
        if(!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
      },
      onDrop(event: DragEvent) {
        setOver(false);
        void onDrop(target, event);
      }
    }
  };
}

function Breadcrumb({ folder, onOpen, onDrop }: { folder: string | null, onOpen(path: string | null): void, onDrop: FolderActions["dropInto"] }) {
  const { session } = useAdmin();
  const segments = folder ? folder.split("/") : [];
  const crumbs: Array<{ path: string | null, label: string }> = [
    { path: null, label: "All files" },
    ...segments.map((label, i) => ({ path: segments.slice(0, i + 1).join("/"), label }))
  ];
  return (
    <nav aria-label="Folder" className="-ml-1.5 min-w-0 text-sm text-muted-foreground">
      {/* One line; a deep path folds its middle into "…", which lists the folders it hides. */}
      <CollapsedPath
        items={crumbs}
        label={crumb => crumb.label}
        separator={<ChevronRightIcon className="mx-0.5 size-3.5 opacity-50" />}
        onOpen={crumb => onOpen(crumb.path)}
        renderItem={(crumb, current) => <Crumb crumb={crumb} current={current} onOpen={onOpen} onDrop={onDrop} canDrop={session.permissions.media.write} />}
      />
    </nav>
  );
}

function Crumb({ crumb, current, onOpen, onDrop, canDrop }: {
  crumb: { path: string | null, label: string },
  current: boolean,
  onOpen(path: string | null): void,
  onDrop: FolderActions["dropInto"],
  canDrop: boolean
}) {
  const drop = useDropTarget(crumb.path, onDrop, canDrop);
  return (
    <button
      type="button"
      {...drop.props}
      onClick={() => onOpen(crumb.path)}
      aria-current={current ? "location" : undefined}
      className={cn(
        "max-w-48 min-w-0 truncate rounded-[8px] px-1.5 py-0.5 transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
        current && "font-medium text-foreground",
        drop.over && "bg-foreground/[0.08] text-foreground"
      )}
    >
      {crumb.label}
    </button>
  );
}

// --- Tree view ---------------------------------------------------------------------

/**
 * A file tree (after shadcn's AI Elements one) on the editor's material: a
 * 16px card with 6px padding around 10px rows, 16px of indent per level.
 * A 22px gutter on the left holds the selection checkboxes, so they line up
 * whatever the depth.
 */
const GUTTER = 22;

/**
 * Arrow keys over a list of rows marked `data-nav` (`"folder"`, `"file"`, `"parent"`): Up and Down
 * move between them in screen order, selecting files as they're reached so the preview follows;
 * Left and Right are the view's to decide. Modified keys are left alone (Shift-click still extends).
 */
function navigateRows(event: React.KeyboardEvent<HTMLElement>, keys: { left(row: HTMLElement): void, right(row: HTMLElement): void }) {
  if(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  const row = (event.target as HTMLElement).closest<HTMLElement>("[data-nav]");
  if(!row || !event.currentTarget.contains(row)) return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]")];
  const at = rows.indexOf(row);
  if(event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusRow(rows[at + (event.key === "ArrowDown" ? 1 : -1)]);
  } else if(event.key === "ArrowRight") {
    event.preventDefault();
    keys.right(row);
  } else if(event.key === "ArrowLeft") {
    event.preventDefault();
    keys.left(row);
  }
}

function focusRow(row: HTMLElement | undefined | null) {
  if(!row) return;
  row.focus();
  row.scrollIntoView({ block: "nearest" });
  // Reaching a file selects it, like clicking it, so the preview keeps up.
  if(row.dataset.nav === "file") row.click();
}

/**
 * Arrow keys in the Folders view's file grid move as it's laid out: Left and Right to the
 * neighbouring file, Up and Down a whole row of the grid. Up from the top row goes back to the
 * folder list above, if there is one. Returns whether it handled the key.
 */
function moveInGrid(event: React.KeyboardEvent<HTMLElement>, leftGrid: (file: HTMLElement) => void): boolean {
  if(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if(!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return false;
  const file = (event.target as HTMLElement).closest<HTMLElement>("[data-nav=file]");
  if(!file || !event.currentTarget.contains(file)) return false;
  event.preventDefault();
  const files = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav=file]")];
  const at = files.indexOf(file);
  // Columns: how many files share the first file's row.
  const top = files[0]!.getBoundingClientRect().top;
  const columns = Math.max(1, files.filter(f => Math.abs(f.getBoundingClientRect().top - top) < 2).length);
  if(event.key === "ArrowLeft") focusRow(files[at - 1]);
  else if(event.key === "ArrowRight") focusRow(files[at + 1]);
  else if(event.key === "ArrowUp") {
    if(at - columns >= 0) focusRow(files[at - columns]);
    else {
      // Above the grid: the last folder row. Down from there comes back to this file.
      const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]:not([data-nav=file])")];
      if(rows.length) {
        leftGrid(file);
        focusRow(rows.at(-1));
      }
    }
  } else {
    const row = Math.floor(at / columns);
    const lastRow = Math.floor((files.length - 1) / columns);
    // Down from a row with a shorter one below lands on that row's last file.
    if(row < lastRow) focusRow(files[Math.min(at + columns, files.length - 1)]);
  }
  return true;
}

/** A row's highlight while the keyboard is on it. */
const KEY_FOCUS = "has-[[data-nav]:focus-visible]:bg-foreground/[0.06] has-[[data-nav]:focus-visible]:shadow-[inset_0_0_0_1.5px_var(--ring)]";

function indent(depth: number, file = false): number {
  // Files sit 20px further in than folders: past the chevron, so their icon lines up under the folder's name.
  return 6 + GUTTER + depth * 16 + (file ? 20 : 0);
}
function TreeView({ library, folder, reveal, selected, onSelect, actions }: {
  library: Library,
  folder: string | null,
  /** Folders to open, e.g. everything a dropped folder brought in. */
  reveal: string[],
  selected: string | null,
  onSelect(id: string, folder: string | null): void,
  actions: FolderActions
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(folder ? folder.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")) : []));
  const root = useDropTarget(null, actions.dropInto, library.canWrite);
  const rootFiles = useFolderFiles(null);

  useEffect(() => {
    if(reveal.length) setExpanded(prev => new Set([...prev, ...reveal]));
  }, [reveal]);

  // Keep the current folder visible when it changes from elsewhere (breadcrumb, new folder).
  useEffect(() => {
    if(!folder) return;
    setExpanded(prev => {
      const next = new Set(prev);
      folder.split("/").forEach((_, i, parts) => next.add(parts.slice(0, i + 1).join("/")));
      return next;
    });
  }, [folder]);

  function toggle(path: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if(next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if(library.loading || rootFiles.isLoading) {
    return <Delayed><div className="flex flex-col gap-1 rounded-[16px] elevated p-1.5">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-8 rounded-[10px]" />)}</div></Delayed>;
  }
  const topFolders = library.childrenOf(null);
  const files = rootFiles.data?.assets ?? [];
  return (
    <div
      role="tree"
      aria-label="Files"
      onKeyDown={event => navigateRows(event, {
        right(row) {
          if(row.dataset.nav !== "folder") return;
          // Closed: open it (as a click does). Open: step to its first row.
          if(row.dataset.open !== "true") row.click();
          else focusRow(row.closest("[role=treeitem]")?.querySelector<HTMLElement>("[role=group] [data-nav]"));
        },
        left(row) {
          // An open folder closes (as a click does, stepping out of it); anything else goes to its folder.
          if(row.dataset.nav === "folder" && row.dataset.open === "true") row.click();
          else focusRow(row.closest("[role=treeitem]")?.parentElement?.closest("[role=treeitem]")?.querySelector<HTMLElement>("[data-nav]"));
        }
      })}
      {...root.props}
      data-drop-area=""
      className={cn("flex min-h-64 flex-col gap-px rounded-[16px] elevated p-1.5 transition-shadow duration-300", root.over && "drop-glow")}
    >
      {topFolders.length === 0 && files.length === 0 && <EmptyLibrary />}
      {topFolders.map(f => (
        <TreeFolder key={f.path} path={f.path} depth={0} library={library} expanded={expanded} toggle={toggle} current={folder} selected={selected} onSelect={onSelect} actions={actions} />
      ))}
      {files.map(asset => (
        <TreeFile key={asset.id} asset={asset} depth={0} selected={selected === asset.id} onSelect={() => onSelect(asset.id, null)} onOpen={() => actions.openFile(asset)} />
      ))}
    </div>
  );
}

function TreeFolder({ path, depth, library, expanded, toggle, current, selected, onSelect, actions }: {
  path: string,
  depth: number,
  library: Library,
  expanded: Set<string>,
  toggle(path: string): void,
  current: string | null,
  selected: string | null,
  onSelect(id: string, folder: string | null): void,
  actions: FolderActions
}) {
  const open = expanded.has(path);
  const files = useFolderFiles(path, open);
  const drop = useDropTarget(path, actions.dropInto, library.canWrite);
  const subfolders = library.childrenOf(path);
  const item: Item = { kind: "folder", path };
  const { key, picked, selection } = usePick(item);
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={picked || current === path}>
      <div
        data-pick={key}
        {...drop.props}
        {...selection.drag(item)}
        className={cn(
          "group/row group/pick relative flex h-8 items-center gap-1.5 rounded-[10px] pr-1 text-sm transition-[background-color,box-shadow] duration-150",
          KEY_FOCUS,
          picked ? "raised font-medium" : current === path ? "bg-foreground/[0.06] font-medium" : "hover:bg-foreground/[0.04]",
          drop.over && "bg-foreground/[0.1] shadow-[inset_0_0_0_1px_var(--brand)]"
        )}
        style={{ paddingLeft: indent(depth) }}
      >
        <PickBox item={item} className="absolute top-1/2 left-2 -translate-y-1/2" />
        <button
          type="button"
          data-nav="folder"
          data-open={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none"
          onClick={event => selection.click(item, event, () => {
            toggle(path);
            // Closing a folder steps out of it, so uploads and the preview don't stay in a folder you can't see.
            actions.open(open ? parentOf(path) : path);
          })}
        >
          <ChevronRightIcon className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform duration-150", open && "rotate-90")} />
          {open ? <FolderOpenIcon className="size-4 shrink-0 text-muted-foreground" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
          <span className="truncate">{nameOf(path)}</span>
        </button>
        <span className="text-xs text-muted-foreground tabular-nums group-focus-within/row:hidden group-hover/row:hidden">{library.itemCount(path) || ""}</span>
        <FolderMenu path={path} library={library} actions={actions} className="hidden size-6 rounded-[6px] group-focus-within/row:flex group-hover/row:flex data-popup-open:flex" />
      </div>
      {open && (
        <div role="group" className="flex flex-col gap-px pt-px">
          {subfolders.map(f => (
            <TreeFolder key={f.path} path={f.path} depth={depth + 1} library={library} expanded={expanded} toggle={toggle} current={current} selected={selected} onSelect={onSelect} actions={actions} />
          ))}
          {files.isLoading && <div className="h-8 px-2 py-1.5" style={{ paddingLeft: indent(depth + 1, true) }}><Spinner className="size-3.5" /></div>}
          {files.data?.assets.map(asset => (
            <TreeFile key={asset.id} asset={asset} depth={depth + 1} selected={selected === asset.id} onSelect={() => onSelect(asset.id, path)} onOpen={() => actions.openFile(asset)} />
          ))}
          {!files.isLoading && subfolders.length === 0 && files.data?.assets.length === 0 && (
            <p className="h-8 py-1.5 text-xs text-muted-foreground" style={{ paddingLeft: indent(depth + 1, true) }}>Empty</p>
          )}
        </div>
      )}
    </div>
  );
}

function TreeFile({ asset, depth, selected, onSelect, onOpen }: { asset: Asset, depth: number, selected: boolean, onSelect(): void, onOpen(): void }) {
  const item: Item = { kind: "file", asset };
  const { key, picked, selection } = usePick(item);
  const highlighted = picked || (selected && !selection.multi);
  return (
    <div
      role="treeitem"
      aria-selected={highlighted}
      data-pick={key}
      {...selection.drag(item)}
      className={cn(
        "group/pick relative flex h-8 items-center rounded-[10px] text-sm transition-[background-color,box-shadow] duration-150",
        KEY_FOCUS,
        highlighted ? "raised font-medium" : "hover:bg-foreground/[0.04]"
      )}
    >
      <PickBox item={item} className="absolute top-1/2 left-2 -translate-y-1/2" />
      <button
        type="button"
        data-nav="file"
        onClick={event => selection.click(item, event, onSelect)}
        onDoubleClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 self-stretch pr-2 text-left outline-none"
        style={{ paddingLeft: indent(depth, true) }}
      >
        <FileGlyph asset={asset} className="size-5 rounded-[4px]" />
        <span className="min-w-0 flex-1 truncate">{asset.filename}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(asset.size)}</span>
      </button>
    </div>
  );
}

function FileGlyph({ asset, className }: { asset: Asset, className?: string }) {
  if(asset.mime.startsWith("image/")) return <img src={asset.url} alt="" loading="lazy" draggable={false} className={cn("shrink-0 object-cover shadow-[0_0_0_1px_rgb(0_0_0/0.08)]", className)} />;
  const Icon = asset.mime.startsWith("video/") ? FilmIcon : FileIcon;
  return <span className={cn("flex shrink-0 items-center justify-center text-muted-foreground", className)}><Icon className="size-4" /></span>;
}

function FolderMenu({ path, library, actions, className }: { path: string, library: Library, actions: FolderActions, className?: string }) {
  if(!library.canWrite && !library.canDelete) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${nameOf(path)}`} className={cn("shrink-0 items-center justify-center", className)} onClick={e => e.stopPropagation()}>
          <MoreHorizontalIcon />
        </Button>
      } />
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => actions.open(path)}><FolderOpenIcon /> Open</DropdownMenuItem>
          {library.canWrite && (
            <>
              <DropdownMenuItem onClick={() => actions.newFolder(path)}><FolderPlusIcon /> New folder inside</DropdownMenuItem>
              <DropdownMenuItem onClick={() => actions.rename(path)}><PencilIcon /> Rename…</DropdownMenuItem>
              <DropdownMenuItem onClick={() => actions.move(path)}><FolderInputIcon /> Move to…</DropdownMenuItem>
            </>
          )}
        </DropdownMenuGroup>
        {library.canDelete && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" disabled={library.itemCount(path) > 0} onClick={() => actions.remove(path)}>
              <Trash2Icon /> {library.itemCount(path) > 0 ? "Delete (empty it first)" : "Delete"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// --- Folders view --------------------------------------------------------------------

/** The current folder's subfolders as a list, its files as a grid. */
function GridView({ library, folder, selected, onSelect, actions }: {
  library: Library,
  folder: string | null,
  selected: string | null,
  onSelect(id: string): void,
  actions: FolderActions
}) {
  const files = useFolderFiles(folder);
  const subfolders = library.childrenOf(folder);
  const loading = library.loading || files.isLoading;
  const view = useRef<HTMLDivElement>(null);
  // Moving between folders with the keyboard keeps the keyboard in the view: on the folder just
  // left (going up), else the first thing inside (not the "Parent folder" row).
  const keyed = useRef<{ from: string | null } | null>(null);
  useEffect(() => {
    const pending = keyed.current;
    if(!pending || loading) return;
    keyed.current = null;
    const rows = [...(view.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
    const target = rows.find(r => pending.from !== null && r.dataset.path === pending.from) ?? rows.find(r => r.dataset.nav !== "parent") ?? rows[0];
    target?.focus();
  }, [folder, loading]);
  function go(path: string | null) {
    keyed.current = { from: folder };
    actions.open(path);
  }
  // The file the keyboard left the grid from, going up into the folder list; Down returns to it.
  const gridSpot = useRef<string | null>(null);
  useEffect(() => {
    gridSpot.current = null;
  }, [folder]);
  /** Down from the last folder row: back to the file Up left from, if it's still there. */
  function returnToGrid(event: React.KeyboardEvent<HTMLElement>): boolean {
    if(event.key !== "ArrowDown" || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !gridSpot.current) return false;
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-nav]");
    const above = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav]:not([data-nav=file])")];
    if(!row || row !== above.at(-1)) return false;
    const file = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-nav=file]")]
      .find(f => f.closest<HTMLElement>("[data-pick]")?.dataset.pick === gridSpot.current);
    if(!file) return false;
    event.preventDefault();
    focusRow(file);
    return true;
  }
  return (
    <div
      ref={view}
      data-drop-area=""
      className="flex flex-col gap-5 rounded-[16px] transition-shadow duration-300"
      onKeyDown={event => {
        if(returnToGrid(event)) return;
        if(moveInGrid(event, file => {
          gridSpot.current = file.closest<HTMLElement>("[data-pick]")?.dataset.pick ?? null;
        })) return;
        navigateRows(event, {
          right(row) {
            if(row.dataset.nav === "folder") go(row.dataset.path!);
          },
          left() {
            if(folder !== null) go(parentOf(folder));
          }
        });
      }}
    >
      {(folder !== null || subfolders.length > 0) && (
        // 4px of card padding around 12px rows: a 16px card.
        <div className="stagger flex flex-col gap-0.5 rounded-[16px] elevated p-1">
          {folder !== null && <ParentRow folder={folder} library={library} actions={actions} />}
          {subfolders.map((f, i) => <FolderRow key={f.path} path={f.path} index={i + 1} library={library} actions={actions} />)}
        </div>
      )}
      {loading ? (
        <Delayed><div className="grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="aspect-[4/3.6] rounded-[14px]" />)}</div></Delayed>
      ) : files.data?.assets.length ? (
        <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
          {files.data.assets.map((asset, i) => (
            <GridFile key={asset.id} asset={asset} index={i} selected={selected === asset.id} onSelect={() => onSelect(asset.id)} onOpen={() => actions.openFile(asset)} />
          ))}
        </div>
      ) : subfolders.length === 0 ? <EmptyLibrary folder={folder} /> : (
        <p className="px-1 text-sm text-muted-foreground">No files directly in this folder.</p>
      )}
    </div>
  );
}

function GridFile({ asset, index, selected, onSelect, onOpen, caption }: {
  asset: Asset,
  index: number,
  selected: boolean,
  onSelect(): void,
  onOpen?(): void,
  caption?: string
}) {
  const item: Item = { kind: "file", asset };
  const { key, picked, selection } = usePick(item);
  return (
    <div data-pick={key} {...selection.drag(item)} onDoubleClick={onOpen} style={staggerIndex(index)} className="group/pick relative grid gap-1">
      <AssetThumb asset={asset} nav selected={picked || (selected && !selection.multi)} onClick={event => selection.click(item, event, onSelect)} />
      {/* 8px into the 14px thumbnail corner: a 6px checkbox corner. */}
      <PickBox item={item} className="absolute top-2 left-2 z-10 rounded-[6px] shadow-[0_1px_3px_rgb(0_0_0/0.3)]" />
      {caption && <span className="truncate px-1 text-[11px] text-muted-foreground">{caption}</span>}
    </div>
  );
}

/** Always first inside a folder: up one level. Also a drop target for moving things there. */
function ParentRow({ folder, library, actions }: { folder: string, library: Library, actions: FolderActions }) {
  const parent = parentOf(folder);
  const drop = useDropTarget(parent, actions.dropInto, library.canWrite);
  return (
    <button
      type="button"
      data-nav="parent"
      {...drop.props}
      onClick={() => actions.open(parent)}
      style={staggerIndex(0)}
      className={cn(
        "flex h-11 items-center gap-3 rounded-[12px] px-3 text-left text-sm text-muted-foreground transition-[background-color,color,scale] duration-150 outline-none hover:bg-foreground/[0.04] hover:text-foreground focus-visible:bg-foreground/[0.06] focus-visible:text-foreground focus-visible:shadow-[inset_0_0_0_1.5px_var(--ring)] active:scale-[0.995]",
        drop.over && "bg-foreground/[0.08] text-foreground shadow-[inset_0_0_0_1px_var(--brand)]"
      )}
    >
      <CornerLeftUpIcon className="size-4 shrink-0" />
      <span className="truncate">{parent ? nameOf(parent) : "All files"}</span>
      <span className="ml-auto pr-1 text-xs">Parent folder</span>
    </button>
  );
}

function FolderRow({ path, index, library, actions }: { path: string, index: number, library: Library, actions: FolderActions }) {
  const drop = useDropTarget(path, actions.dropInto, library.canWrite);
  const count = library.itemCount(path);
  const item: Item = { kind: "folder", path };
  const { key, picked, selection } = usePick(item);
  return (
    <div
      data-pick={key}
      {...drop.props}
      {...selection.drag(item)}
      style={staggerIndex(index)}
      className={cn(
        "group/pick flex h-11 items-center gap-1 rounded-[12px] pr-1.5 pl-2 transition-[background-color,box-shadow,scale] duration-150 active:scale-[0.995]",
        KEY_FOCUS,
        picked ? "raised" : "hover:bg-foreground/[0.04]",
        drop.over && "bg-foreground/[0.08] shadow-[inset_0_0_0_1px_var(--brand)]"
      )}
    >
      <PickBox item={item} />
      <button type="button" data-nav="folder" data-path={path} onClick={event => selection.click(item, event, () => actions.open(path))} className="flex min-w-0 flex-1 items-center gap-3 self-stretch pl-2.5 text-left text-sm outline-none">
        <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate font-medium">{nameOf(path)}</span>
        <span className="ml-auto pr-1 text-xs text-muted-foreground tabular-nums">{count === 1 ? "1 item" : `${count} items`}</span>
      </button>
      {/* 6px in from the 12px row's edge: a 6px corner. */}
      <FolderMenu path={path} library={library} actions={actions} className="size-8 rounded-[6px]" />
    </div>
  );
}

function SearchResults({ loading, assets, selected, onSelect, query }: { loading: boolean, assets: Asset[] | undefined, selected: string | null, onSelect(id: string): void, query: string }) {
  if(loading) return <Delayed><div className="flex justify-center p-8"><Spinner /></div></Delayed>;
  if(!assets?.length) return <p className="rounded-[16px] well p-6 text-sm text-muted-foreground">No files match “{query}”.</p>;
  return (
    <div className="stagger grid grid-cols-[repeat(auto-fill,minmax(9.5rem,1fr))] gap-3">
      {assets.map((asset, i) => (
        <GridFile key={asset.id} asset={asset} index={i} selected={selected === asset.id} onSelect={() => onSelect(asset.id)} caption={asset.folder ?? "All files"} />
      ))}
    </div>
  );
}

function EmptyLibrary({ folder }: { folder?: string | null }) {
  return (
    <Empty className="rounded-[16px] well">
      <EmptyHeader>
        <EmptyMedia variant="icon"><FolderOpenIcon /></EmptyMedia>
        <EmptyTitle>{folder ? `${nameOf(folder)} is empty` : "No files yet"}</EmptyTitle>
        <EmptyDescription>Upload images, video and documents, or drop them here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

// --- Preview pane --------------------------------------------------------------------

/**
 * Sticky beside the browser. Radii nest: an 18px card with 8px of padding
 * around the 10px preview well.
 */
function PreviewPane({ id, folder, library, onMove, onEdit, onRename, onDeleted, onOpenFolder }: {
  id: string | null,
  folder: string | null,
  library: Library,
  onMove(asset: Asset): void,
  onEdit(asset: Asset): void,
  onRename(asset: Asset, filename: string): Promise<void>,
  onDeleted(asset: Asset, trash: string): void,
  onOpenFolder(path: string | null): void
}) {
  const { cms } = useAdmin();
  const detail = useQuery({
    queryKey: ["asset-detail", id],
    enabled: id !== null,
    queryFn: () => cms.actions.assets.get({ id: id! }),
    retry: false
  });
  const [filename, setFilename] = useState("");
  useEffect(() => {
    if(detail.data) setFilename(detail.data.filename);
  }, [detail.data?.filename]);

  if(!id || detail.isError) {
    const subfolders = library.childrenOf(folder).length;
    const files = folder ? library.folders.find(f => f.path === folder)?.files ?? 0 : null;
    return (
      <div className="flex flex-col items-center gap-3 rounded-[18px] elevated px-6 py-10 text-center">
        <div className="flex size-12 items-center justify-center rounded-[14px] well text-muted-foreground"><FolderOpenIcon className="size-5" /></div>
        <div className="space-y-1">
          <p className="font-medium">{folder ? nameOf(folder) : "All files"}</p>
          <p className="text-xs text-muted-foreground">
            {files !== null ? `${files} ${files === 1 ? "file" : "files"} · ` : ""}{subfolders} {subfolders === 1 ? "folder" : "folders"}
          </p>
        </div>
        <p className="text-sm text-balance text-muted-foreground">Select a file to preview it here.</p>
      </div>
    );
  }
  const asset = detail.data;
  if(!asset) return <div className="flex justify-center rounded-[18px] elevated p-10"><Delayed><Spinner /></Delayed></div>;
  const url = new URL(asset.url, location.href).href;

  async function saveName() {
    const next = filename.trim();
    if(!next || next === asset!.filename) {
      setFilename(asset!.filename);
      return;
    }
    await onRename(asset!, next);
  }

  return (
    <div className="flex flex-col gap-4 rounded-[18px] elevated p-2 pb-4">
      {/* The checkerboard shows transparency in images; text gets a plain well. */}
      <div className={cn("overflow-hidden rounded-[10px] well", !assetTextKind(asset) && "bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]")}>
        {assetTextKind(asset) ? <TextPreview asset={asset} /> : <AssetPreview asset={asset} />}
      </div>
      <div className="flex flex-col gap-4 px-2">
        {assetTextKind(asset) && library.canWrite && (
          <Button variant="outline" onClick={() => onEdit(asset)}><PencilIcon /> Edit {assetTextKind(asset) === "csv" ? "table" : "text"}</Button>
        )}
        <div className="flex flex-col gap-1">
          <Input
            aria-label="File name"
            value={filename}
            readOnly={!library.canWrite}
            onChange={e => setFilename(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={e => {
              if(e.key === "Enter") e.currentTarget.blur();
              if(e.key === "Escape") setFilename(asset.filename);
            }}
            className="h-8 font-medium"
          />
          <p className="px-1 text-xs text-muted-foreground">{describeAsset(asset)}</p>
        </div>

        <Row label="Folder">
          <div className="flex min-w-0 items-center gap-1">
            <button type="button" onClick={() => onOpenFolder(asset.folder)} className="flex min-w-0 items-center gap-1.5 rounded-[8px] px-1.5 py-1 text-sm hover:bg-foreground/[0.05]">
              <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{asset.folder ?? "All files"}</span>
            </button>
            {library.canWrite && <Button variant="ghost" size="xs" onClick={() => onMove(asset)}>Move</Button>}
          </div>
        </Row>
        <Row label="Uploaded"><span className="px-1.5 text-sm">{formatDate(asset.createdAt)}</span></Row>

        <div className="flex items-center gap-1.5">
          <Input readOnly value={url} className="h-8 font-mono text-xs" onFocus={e => e.target.select()} aria-label="File URL" />
          <Button variant="outline" size="icon" aria-label="Copy URL" onClick={() => {
            void navigator.clipboard.writeText(url);
            cms.toast("URL copied");
          }}><CopyIcon /></Button>
        </div>

        <div className="flex flex-col gap-1">
          <h4 className="eyebrow px-1">Used in</h4>
          {asset.usage.length === 0 ? <p className="px-1 text-sm text-muted-foreground">Not used by any document.</p> : (
            <ul className="-mx-0.5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-0.5 text-sm">
              {asset.usage.map(u => <li key={`${u.id}/${u.locale}`}><UsageLink type={u.type} id={u.id} locale={u.locale} /></li>)}
            </ul>
          )}
        </div>

        {hasMetadataSupport(asset.mime) && (
          <div className="flex flex-col gap-1.5">
            <h4 className="eyebrow px-1">Metadata</h4>
            <div className="px-1">
              <StoredMetadata
                url={url}
                mime={asset.mime}
                canWrite={library.canWrite}
                onRemove={async () => {
                  try {
                    await cms.actions.assets.stripMetadata({ id: asset.id });
                    cms.toast("Removed location and camera details", { type: "success" });
                  } catch (error) {
                    cms.toast(error instanceof ApiError ? error.message : "Couldn't remove the details", { type: "error" });
                  }
                  library.refresh();
                  await detail.refetch();
                }}
              />
            </div>
          </div>
        )}

        {library.canDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="w-fit text-destructive"
            disabled={asset.usage.length > 0}
            title={asset.usage.length > 0 ? "Remove it from those documents first" : undefined}
            onClick={async () => {
              const deleted = await library.deleteAsset(asset.id);
              if(deleted) onDeleted(asset, deleted.trash);
            }}
          >
            <Trash2Icon /> Delete file
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string, children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="eyebrow shrink-0 px-1">{label}</span>
      {children}
    </div>
  );
}

// --- Dialogs ----------------------------------------------------------------------------

function FolderNameDialog({ open, title, description, initial, submitLabel, onOpenChange, onSubmit }: {
  open: boolean,
  title: string,
  description?: ReactNode,
  initial: string,
  submitLabel: string,
  onOpenChange(open: boolean): void,
  onSubmit(name: string): Promise<void>
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if(open) setName(initial);
  }, [open, initial]);
  const valid = name.trim() && !name.includes("/");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        {/* min-w-0: a long path wraps inside the dialog instead of widening the form past it. */}
        <form className="flex min-w-0 flex-col gap-4" onSubmit={async event => {
          event.preventDefault();
          if(!valid) return;
          setBusy(true);
          await onSubmit(name.trim());
          setBusy(false);
        }}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Folder name" aria-label="Folder name" />
          {name.includes("/") && <p className="text-xs text-destructive">Folder names can't contain “/”.</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={!valid || busy}>{busy && <Spinner />} {submitLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A folder path on one line: "All files" at the top; a long path folds its middle into "…". */
function FolderPath({ path }: { path: string | null }) {
  if(!path) return <span className="font-medium text-foreground">All files</span>;
  return (
    <CollapsedPath
      items={path.split("/")}
      label={part => part}
      separator="/"
      renderItem={(part, last) => <span className={cn("truncate", last && "font-medium text-foreground")} title={last ? path : undefined}>{part}</span>}
    />
  );
}

/** Picks a destination folder. A folder can't go into itself or its own subfolders. */
function MoveDialog({ library, bulk, onOpenChange, onMove }: {
  library: Library,
  bulk: Bulk | null,
  onOpenChange(open: boolean): void,
  onMove(target: string | null): Promise<void>
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Where everything currently is, if that's one place.
  const places = bulk ? new Set([...bulk.files.map(f => f.folder), ...bulk.folders.map(parentOf)]) : new Set<string | null>();
  const current = places.size === 1 ? [...places][0]! : undefined;
  useEffect(() => {
    if(bulk) setTarget(current ?? null);
  }, [bulk]);
  const name = bulk ? bulkLabel(bulk) : "";
  const options: Array<{ path: string | null, depth: number }> = [
    { path: null, depth: 0 },
    ...library.folders
      .filter(f => !bulk?.folders.some(moving => isInside(f.path, moving)))
      .map(f => ({ path: f.path, depth: f.path.split("/").length }))
  ];
  return (
    <Dialog open={bulk !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Move “{name}”</DialogTitle>
          <DialogDescription>{bulk && bulk.files.length + bulk.folders.length > 1 ? "Choose where they should live." : "Choose where it should live."}</DialogDescription>
        </DialogHeader>
        {/* 4px of well around 10px rows: a 14px well. */}
        <div role="listbox" aria-label="Destination" className="flex max-h-72 flex-col gap-px overflow-y-auto rounded-[14px] well p-1">
          {options.map(option => (
            <button
              key={option.path ?? ""}
              type="button"
              role="option"
              aria-selected={target === option.path}
              onClick={() => setTarget(option.path)}
              className={cn(
                "flex h-8 shrink-0 items-center gap-2 rounded-[10px] pr-2 text-left text-sm transition-colors",
                target === option.path ? "raised font-medium" : "hover:bg-foreground/[0.05]"
              )}
              style={{ paddingLeft: 8 + option.depth * 16 }}
            >
              <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{option.path ? nameOf(option.path) : "All files"}</span>
              {option.path === current && <span className="ml-auto text-xs text-muted-foreground">Current</span>}
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={target === current || busy} onClick={async () => {
            setBusy(true);
            await onMove(target);
            setBusy(false);
          }}>{busy && <Spinner />} Move here</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Bulk actions --------------------------------------------------------------------------

function describeBulk(bulk: Bulk): string {
  const parts: string[] = [];
  if(bulk.files.length) parts.push(`${bulk.files.length} ${bulk.files.length === 1 ? "file" : "files"}`);
  if(bulk.folders.length) parts.push(`${bulk.folders.length} ${bulk.folders.length === 1 ? "folder" : "folders"}`);
  return parts.join(" · ");
}

/**
 * Floats at the bottom of the browser while several things are selected.
 * Radii nest: 6px of bar padding around 10px buttons makes a 16px bar.
 */
function SelectionBar({ bulk, canWrite, canDelete, onMove, onDelete, onClear }: {
  bulk: Bulk,
  canWrite: boolean,
  canDelete: boolean,
  onMove(): void,
  onDelete(): void,
  onClear(): void
}) {
  const count = bulk.files.length + bulk.folders.length;
  return (
    <div role="toolbar" aria-label="Selection" className="sticky bottom-4 z-30 mx-auto mt-4 flex w-fit items-center gap-1 rounded-[16px] floating p-1.5 duration-150 animate-in fade-in slide-in-from-bottom-2">
      <div className="px-2.5 leading-tight">
        <p className="text-sm font-medium tabular-nums">{count} selected</p>
        <p className="text-[11px] text-muted-foreground">{describeBulk(bulk)}</p>
      </div>
      {canWrite && <Button variant="ghost" onClick={onMove}><FolderInputIcon /> Move…</Button>}
      {canDelete && <Button variant="ghost" className="text-destructive" onClick={onDelete}><Trash2Icon /> Delete</Button>}
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Clear selection" onClick={onClear}><XIcon /></Button>} />
        <TooltipContent>Clear selection <Kbd>Esc</Kbd></TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Takes the preview pane's place while several things are selected. */
function SelectionSummary({ items }: { items: Item[] }) {
  const bulk = toBulk(items);
  const size = bulk.files.reduce((sum, f) => sum + f.size, 0);
  const images = items.filter((i): i is Extract<Item, { kind: "file" }> => i.kind === "file" && i.asset.mime.startsWith("image/")).slice(0, 4);
  const shown = items.slice(0, 8);
  return (
    <div className="flex flex-col gap-4 rounded-[18px] elevated p-2 pb-4">
      {/* 4px of well around 6px tiles: a 10px well, 8px inside the 18px card. */}
      <div className="grid aspect-[4/3] grid-cols-2 gap-1 overflow-hidden rounded-[10px] well p-1">
        {images.length > 0 ? images.map(i => (
          <img key={i.asset.id} src={i.asset.url} alt="" className={cn("size-full rounded-[6px] object-cover", images.length === 1 && "col-span-2 row-span-2", images.length === 3 && i === images[0] && "row-span-2")} />
        )) : (
          <div className="col-span-2 row-span-2 flex items-center justify-center text-muted-foreground"><FolderOpenIcon className="size-8" /></div>
        )}
      </div>
      <div className="flex flex-col gap-3 px-2">
        <div className="space-y-0.5">
          <p className="font-medium tabular-nums">{items.length} selected</p>
          <p className="text-xs text-muted-foreground">{describeBulk(bulk)}{bulk.files.length ? ` · ${formatBytes(size)}` : ""}</p>
        </div>
        <ul className="grid gap-0.5 text-sm">
          {shown.map(item => (
            <li key={itemKey(item)} className="flex min-w-0 items-center gap-2 px-1 py-0.5">
              {item.kind === "file" ? <FileGlyph asset={item.asset} className="size-4 rounded-[3px]" /> : <FolderIcon className="size-4 shrink-0 text-muted-foreground" />}
              <span className="truncate">{item.kind === "file" ? item.asset.filename : nameOf(item.path)}</span>
            </li>
          ))}
          {items.length > shown.length && <li className="px-1 text-xs text-muted-foreground">and {items.length - shown.length} more</li>}
        </ul>
        <p className="text-xs text-muted-foreground">Drag any of them to move them all. <Kbd>Esc</Kbd> clears.</p>
      </div>
    </div>
  );
}

function DeleteDialog({ bulk, onOpenChange, onDelete }: { bulk: Bulk | null, onOpenChange(open: boolean): void, onDelete(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={bulk !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Delete {bulk ? bulkLabel(bulk) : ""}?</DialogTitle>
          <DialogDescription>
            {bulk && describeBulk(bulk)}. Files go to the trash, where they can be restored. Files used by documents, and folders that still have other files in them, are kept.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" autoFocus disabled={busy} onClick={async () => {
            setBusy(true);
            await onDelete();
            setBusy(false);
          }}>{busy && <Spinner />} Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
