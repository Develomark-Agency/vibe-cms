import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
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
  UploadIcon
} from "lucide-react";
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { MediaFolder } from "../../handler/engine.ts";
import type { Asset } from "../index.ts";
import { Button } from "../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";
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

/** What the media page needs to know about the folder tree, plus the actions that change it. */
function useLibrary() {
  const { cms, session } = useAdmin();
  const queryClient = useQueryClient();
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => cms.api<{ folders: MediaFolder[] }>("/folders") });
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
  }

  async function attempt<T>(action: () => Promise<T>, success?: string): Promise<T | null> {
    try {
      const result = await action();
      if(success) cms.toast(success, { type: "success" });
      return result;
    } catch (error) {
      cms.toast(error instanceof ApiError ? error.message : "Something went wrong", { type: "error" });
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
    createFolder: (path: string) => attempt(() => cms.api<MediaFolder>("/folders", { method: "POST", json: { path } })),
    moveFolder: (from: string, to: string) => attempt(() => cms.api<{ path: string }>("/folders", { method: "PATCH", json: { from, to } })),
    deleteFolder: (path: string) => attempt(() => cms.api(`/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" }), "Folder deleted"),
    moveAsset: (id: string, folder: string | null) => attempt(() => cms.api<Asset>(`/assets/${id}`, { method: "PATCH", json: { folder } })),
    renameAsset: (id: string, filename: string) => attempt(() => cms.api<Asset>(`/assets/${id}`, { method: "PATCH", json: { filename } })),
    deleteAsset: (id: string) => attempt(() => cms.api(`/assets/${id}`, { method: "DELETE" }), "File deleted")
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
  | { kind: "move-folder", path: string }
  | { kind: "move-asset", asset: Asset };

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
  const { upload, uploading } = useUpload();
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

  async function uploadInto(target: string | null, files: FileList | File[]) {
    let last: Asset | null = null;
    for(const file of Array.from(files)) last = await upload(file, { folder: target ?? undefined }) ?? last;
    if(last) go({ folder: target, file: last.id });
  }

  /** Drops onto a folder (or the root, null): desktop files upload into it, files and folders move into it. */
  async function dropInto(target: string | null, event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const assetId = event.dataTransfer.getData(ASSET_TYPE);
    const folderPath = event.dataTransfer.getData(FOLDER_TYPE);
    if(assetId) {
      await library.moveAsset(assetId, target);
    } else if(folderPath) {
      if(target !== null && isInside(target, folderPath)) return;
      if(parentOf(folderPath) === target) return;
      const moved = await library.moveFolder(folderPath, join(target, nameOf(folderPath)));
      if(moved && isInside(folder, folderPath)) go({ folder: moved.path + (folder!.slice(folderPath.length)) });
    } else if(event.dataTransfer.files.length && library.canWrite) {
      await uploadInto(target, event.dataTransfer.files);
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
    move: path => setDialog({ kind: "move-folder", path }),
    async remove(path) {
      if(await library.deleteFolder(path) && isInside(folder, path)) go({ folder: parentOf(path) });
    },
    dropInto
  };

  const searching = query.length > 0;

  return (
    <div
      className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-5 px-4 py-6 md:px-8"
      onDragOver={event => {
        if(!library.canWrite || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
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

      <div className="flex flex-col gap-5 lg:flex-row lg:items-start">
        <div className={cn("min-w-0 flex-1 rounded-[20px] transition-shadow", dragging && "shadow-[0_0_0_2px_var(--brand)]")}>
          {searching ? (
            <SearchResults loading={results.isLoading} assets={results.data?.assets} selected={selected} onSelect={id => select(id)} query={query} />
          ) : view === "tree" ? (
            <TreeView library={library} folder={folder} selected={selected} onSelect={(id, inFolder) => go({ folder: inFolder, file: id })} actions={actions} />
          ) : (
            <GridView library={library} folder={folder} selected={selected} onSelect={id => select(id)} actions={actions} />
          )}
          {library.canWrite && <p className="mt-3 text-xs text-muted-foreground">Drop files anywhere to upload them{folder ? ` into ${nameOf(folder)}` : ""}. Drag files and folders onto a folder to move them.</p>}
        </div>
        {paneOpen && (
          <aside className="w-full shrink-0 lg:sticky lg:top-16 lg:w-80">
            <PreviewPane
              id={selected}
              folder={folder}
              library={library}
              onMove={asset => setDialog({ kind: "move-asset", asset })}
              onEdit={asset => setEditing(asset)}
              onDeleted={() => go({ file: null })}
              onOpenFolder={path => go({ folder: path })}
            />
          </aside>
        )}
      </div>

      <FolderNameDialog
        open={dialog?.kind === "new-folder" || dialog?.kind === "rename-folder"}
        title={dialog?.kind === "rename-folder" ? "Rename folder" : "New folder"}
        description={dialog?.kind === "new-folder" ? `In ${dialog.parent ?? "Media"}` : undefined}
        initial={dialog?.kind === "rename-folder" ? nameOf(dialog.path) : ""}
        submitLabel={dialog?.kind === "rename-folder" ? "Rename" : "Create"}
        onOpenChange={open => !open && setDialog(null)}
        onSubmit={async name => {
          if(dialog?.kind === "new-folder") {
            const created = await library.createFolder(join(dialog.parent, name));
            if(created) go({ folder: created.path, file: null });
          } else if(dialog?.kind === "rename-folder") {
            const moved = await library.moveFolder(dialog.path, join(parentOf(dialog.path), name));
            if(moved && isInside(folder, dialog.path)) go({ folder: moved.path + folder!.slice(dialog.path.length) });
          }
          setDialog(null);
        }}
      />
      {editing && <TextEditorDialog asset={editing} open onOpenChange={open => !open && setEditing(null)} />}
      <MoveDialog
        library={library}
        subject={dialog?.kind === "move-folder" ? { folder: dialog.path } : dialog?.kind === "move-asset" ? { asset: dialog.asset } : null}
        onOpenChange={open => !open && setDialog(null)}
        onMove={async target => {
          if(dialog?.kind === "move-asset") {
            await library.moveAsset(dialog.asset.id, target);
          } else if(dialog?.kind === "move-folder") {
            const moved = await library.moveFolder(dialog.path, join(target, nameOf(dialog.path)));
            if(moved && isInside(folder, dialog.path)) go({ folder: moved.path + folder!.slice(dialog.path.length) });
          }
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

function dragAsset(asset: Asset) {
  return {
    draggable: true,
    onDragStart(event: DragEvent) {
      event.dataTransfer.setData(ASSET_TYPE, asset.id);
      event.dataTransfer.effectAllowed = "move";
    }
  };
}

function dragFolder(path: string) {
  return {
    draggable: true,
    onDragStart(event: DragEvent) {
      event.stopPropagation();
      event.dataTransfer.setData(FOLDER_TYPE, path);
      event.dataTransfer.effectAllowed = "move";
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
    <nav aria-label="Folder" className="-ml-1.5 flex min-w-0 flex-wrap items-center gap-0.5 text-sm text-muted-foreground">
      {crumbs.map((crumb, i) => (
        <span key={crumb.path ?? ""} className="flex items-center gap-0.5">
          {i > 0 && <ChevronRightIcon className="size-3.5 opacity-50" />}
          <Crumb crumb={crumb} current={i === crumbs.length - 1} onOpen={onOpen} onDrop={onDrop} canDrop={session.permissions.media.write} />
        </span>
      ))}
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
        "max-w-48 truncate rounded-[8px] px-1.5 py-0.5 transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
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
 */
function TreeView({ library, folder, selected, onSelect, actions }: {
  library: Library,
  folder: string | null,
  selected: string | null,
  onSelect(id: string, folder: string | null): void,
  actions: FolderActions
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(folder ? folder.split("/").map((_, i, parts) => parts.slice(0, i + 1).join("/")) : []));
  const root = useDropTarget(null, actions.dropInto, library.canWrite);
  const rootFiles = useFolderFiles(null);

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
      {...root.props}
      className={cn("flex min-h-64 flex-col gap-px rounded-[16px] elevated p-1.5 transition-shadow", root.over && "shadow-[0_0_0_2px_var(--brand),var(--shadow-card)]")}
    >
      {topFolders.length === 0 && files.length === 0 && <EmptyLibrary />}
      {topFolders.map(f => (
        <TreeFolder key={f.path} path={f.path} depth={0} library={library} expanded={expanded} toggle={toggle} current={folder} selected={selected} onSelect={onSelect} actions={actions} />
      ))}
      {files.map(asset => (
        <TreeFile key={asset.id} asset={asset} depth={0} selected={selected === asset.id} onSelect={() => onSelect(asset.id, null)} onOpen={() => actions.openFile(asset)} draggable={library.canWrite} />
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
  return (
    <div role="treeitem" aria-expanded={open} aria-selected={current === path}>
      <div
        {...drop.props}
        {...(library.canWrite ? dragFolder(path) : {})}
        className={cn(
          "group/row flex h-8 items-center gap-1.5 rounded-[10px] pr-1 text-sm transition-colors",
          current === path ? "bg-foreground/[0.06] font-medium" : "hover:bg-foreground/[0.04]",
          drop.over && "bg-foreground/[0.1] shadow-[inset_0_0_0_1px_var(--brand)]"
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch text-left outline-none focus-visible:underline"
          onClick={() => {
            toggle(path);
            // Closing a folder steps out of it, so uploads and the preview don't stay in a folder you can't see.
            actions.open(open ? parentOf(path) : path);
          }}
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
          {files.isLoading && <div className="h-8 px-2 py-1.5" style={{ paddingLeft: 6 + (depth + 1) * 16 + 20 }}><Spinner className="size-3.5" /></div>}
          {files.data?.assets.map(asset => (
            <TreeFile key={asset.id} asset={asset} depth={depth + 1} selected={selected === asset.id} onSelect={() => onSelect(asset.id, path)} onOpen={() => actions.openFile(asset)} draggable={library.canWrite} />
          ))}
          {!files.isLoading && subfolders.length === 0 && files.data?.assets.length === 0 && (
            <p className="h-8 py-1.5 text-xs text-muted-foreground" style={{ paddingLeft: 6 + (depth + 1) * 16 + 20 }}>Empty</p>
          )}
        </div>
      )}
    </div>
  );
}

function TreeFile({ asset, depth, selected, onSelect, onOpen, draggable }: { asset: Asset, depth: number, selected: boolean, onSelect(): void, onOpen(): void, draggable: boolean }) {
  return (
    <button
      type="button"
      role="treeitem"
      aria-selected={selected}
      onClick={onSelect}
      onDoubleClick={onOpen}
      {...(draggable ? dragAsset(asset) : {})}
      className={cn(
        "flex h-8 items-center gap-2 rounded-[10px] pr-2 text-left text-sm transition-[background-color,box-shadow] duration-150",
        selected ? "raised font-medium" : "hover:bg-foreground/[0.04]"
      )}
      // 20px more than a folder: past its chevron, so the icon lines up under the folder's name.
      style={{ paddingLeft: 6 + depth * 16 + 20 }}
    >
      <FileGlyph asset={asset} className="size-5 rounded-[4px]" />
      <span className="min-w-0 flex-1 truncate">{asset.filename}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatBytes(asset.size)}</span>
    </button>
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
  return (
    <div className="flex flex-col gap-5">
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
            <div key={asset.id} {...(library.canWrite ? dragAsset(asset) : {})} onDoubleClick={() => actions.openFile(asset)} style={staggerIndex(i)} className="grid">
              <AssetThumb asset={asset} selected={selected === asset.id} onClick={() => onSelect(asset.id)} />
            </div>
          ))}
        </div>
      ) : subfolders.length === 0 ? <EmptyLibrary folder={folder} /> : (
        <p className="px-1 text-sm text-muted-foreground">No files directly in this folder.</p>
      )}
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
      {...drop.props}
      onClick={() => actions.open(parent)}
      style={staggerIndex(0)}
      className={cn(
        "flex h-11 items-center gap-3 rounded-[12px] px-3 text-left text-sm text-muted-foreground transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.04] hover:text-foreground active:scale-[0.995]",
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
  return (
    <div
      {...drop.props}
      {...(library.canWrite ? dragFolder(path) : {})}
      style={staggerIndex(index)}
      className={cn(
        "group/row flex h-11 items-center gap-1 rounded-[12px] pr-1.5 transition-[background-color,scale] duration-150 hover:bg-foreground/[0.04] active:scale-[0.995]",
        drop.over && "bg-foreground/[0.08] shadow-[inset_0_0_0_1px_var(--brand)]"
      )}
    >
      <button type="button" onClick={() => actions.open(path)} className="flex min-w-0 flex-1 items-center gap-3 self-stretch pl-3 text-left text-sm outline-none focus-visible:underline">
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
        <div key={asset.id} style={staggerIndex(i)} className="grid gap-1">
          <AssetThumb asset={asset} selected={selected === asset.id} onClick={() => onSelect(asset.id)} />
          <span className="truncate px-1 text-[11px] text-muted-foreground">{asset.folder ?? "All files"}</span>
        </div>
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
function PreviewPane({ id, folder, library, onMove, onEdit, onDeleted, onOpenFolder }: {
  id: string | null,
  folder: string | null,
  library: Library,
  onMove(asset: Asset): void,
  onEdit(asset: Asset): void,
  onDeleted(): void,
  onOpenFolder(path: string | null): void
}) {
  const { cms } = useAdmin();
  const detail = useQuery({
    queryKey: ["asset-detail", id],
    enabled: id !== null,
    queryFn: () => cms.api<Asset & { usage: Array<{ id: string, type: string, locale: string }> }>(`/assets/${id}`),
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
    await library.renameAsset(asset!.id, next);
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
            <ul className="-mx-0.5 grid gap-0.5 text-sm">
              {asset.usage.map(u => <li key={`${u.id}/${u.locale}`}><UsageLink type={u.type} id={u.id} locale={u.locale} /></li>)}
            </ul>
          )}
        </div>

        {library.canDelete && (
          <Button
            variant="ghost"
            size="sm"
            className="w-fit text-destructive"
            disabled={asset.usage.length > 0}
            title={asset.usage.length > 0 ? "Remove it from those documents first" : undefined}
            onClick={async () => {
              if(await library.deleteAsset(asset.id)) onDeleted();
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
  description?: string,
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
        <form className="flex flex-col gap-4" onSubmit={async event => {
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

/** Picks a destination folder. A folder can't go into itself or its own subfolders. */
function MoveDialog({ library, subject, onOpenChange, onMove }: {
  library: Library,
  subject: { folder: string } | { asset: Asset } | null,
  onOpenChange(open: boolean): void,
  onMove(target: string | null): Promise<void>
}) {
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = subject ? ("folder" in subject ? parentOf(subject.folder) : subject.asset.folder) : null;
  useEffect(() => {
    if(subject) setTarget(current);
  }, [subject]);
  const name = subject ? ("folder" in subject ? nameOf(subject.folder) : subject.asset.filename) : "";
  const options: Array<{ path: string | null, depth: number }> = [
    { path: null, depth: 0 },
    ...library.folders
      .filter(f => !(subject && "folder" in subject && isInside(f.path, subject.folder)))
      .map(f => ({ path: f.path, depth: f.path.split("/").length }))
  ];
  return (
    <Dialog open={subject !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">Move “{name}”</DialogTitle>
          <DialogDescription>Choose where it should live.</DialogDescription>
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
