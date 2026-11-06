import { useQuery, useQueryClient } from "@tanstack/react-query";
import { chooseStripMetadata } from "./upload-metadata.tsx";
import { CollapsedPath } from "./collapsed-path.tsx";
import type { DroppedFile } from "./dropped-files.ts";
import { ChevronRightIcon, ChevronsUpDownIcon, ExternalLinkIcon, FileIcon, FilmIcon, FolderIcon, ImageIcon, LibraryIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react";
import { useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";
import type { AnySchema, AssetSchema, RefSchema } from "../../schema/types.ts";
import type { Issue, Path } from "../../schema/validate.ts";
import type { DocumentData, JsonValue } from "../../schema/types.ts";
import type { Asset, FieldDescriptor } from "../index.ts";
import type { AssetPickerOptions } from "../../media/index.ts";
import { Badge } from "../components/ui/badge.tsx";
import { Button } from "../components/ui/button.tsx";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../components/ui/command.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { cn } from "../lib/utils.ts";
import { ApiError } from "./client.ts";
import { Delayed } from "./delayed.tsx";
import { collectionLabel, documentTitle, humanize, useAdmin } from "./context.tsx";
import { Field, fieldId } from "./fields.tsx";
import { Link } from "./router.tsx";
import { StatusDot } from "./status.tsx";

interface PickerProps {
  schema: AnySchema,
  value: JsonValue | undefined,
  onChange(value: JsonValue | undefined): void,
  path: Path,
  issues: Issue[],
  readOnly: boolean,
  optional: boolean,
  doc: { type: string, id: string | null },
  field: FieldDescriptor
}

// --- References ----------------------------------------------------------------

export function RefControl({ schema, value, onChange, path, readOnly, field }: PickerProps) {
  const { config } = useAdmin();
  const s = schema as RefSchema;
  const types = Object.keys(config.schemas);
  const current = s.to
    ? (typeof value === "string" && value ? { type: s.to, id: value } : null)
    : (value && typeof value === "object" ? value as { type: string, id: string } : null);
  const [pickType, setPickType] = useState(s.to ?? current?.type ?? types[0]!);
  const type = s.to ?? pickType;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!s.to && (
        <Select
          items={types.map(t => ({ value: t, label: collectionLabel(config, t, false) }))}
          value={type}
          onValueChange={next => setPickType(next as string)}
          disabled={readOnly}
        >
          <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>{types.map(t => <SelectItem key={t} value={t}>{collectionLabel(config, t, false)}</SelectItem>)}</SelectContent>
        </Select>
      )}
      <DocumentPicker
        id={fieldId(path)}
        type={type}
        selected={current}
        readOnly={readOnly}
        invalid={field.errors.length > 0}
        onSelect={id => onChange(s.to ? id : { type, id })}
      />
      {current && !readOnly && (
        <Button variant="ghost" size="icon-sm" aria-label="Clear" onClick={() => onChange(undefined)}><XIcon /></Button>
      )}
      {current && (
        <Button variant="ghost" size="icon-sm" aria-label="Open" nativeButton={false} render={<Link to={`/content/${current.type}/${current.id}`} />}>
          <ExternalLinkIcon />
        </Button>
      )}
    </div>
  );
}

function useDocumentTitle(type: string | undefined, id: string | undefined) {
  const { cms, config, locale } = useAdmin();
  return useQuery({
    queryKey: ["document", type, id, locale],
    enabled: Boolean(type && id),
    queryFn: () => cms.actions.documents.get({ type: type!, id: id!, locale }),
    select: doc => ({ title: documentTitle(config, type!, doc.draft ?? doc.fallback), status: doc.status }),
    retry: false
  });
}

function DocumentPicker({ id, type, selected, onSelect, readOnly, invalid }: {
  id: string,
  type: string,
  selected: { type: string, id: string } | null,
  onSelect(id: string): void,
  readOnly: boolean,
  invalid: boolean
}) {
  const { cms, config, locale } = useAdmin();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const title = useDocumentTitle(selected?.type, selected?.id);
  const results = useQuery({
    queryKey: ["documents", type, locale, search],
    enabled: open,
    queryFn: () => cms.documents.list(type, { search, locale, limit: 20 })
  });
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button id={id} variant="outline" disabled={readOnly} aria-invalid={invalid} className="w-72 justify-between font-normal">
            <span className={cn("truncate", !selected && "text-muted-foreground")}>
              {!selected ? `Choose ${collectionLabel(config, type, false).toLowerCase()}…`
                : title.isError ? <span className="text-destructive">Missing document</span>
                  : title.data?.title ?? "Loading…"}
            </span>
            <ChevronsUpDownIcon className="opacity-50" />
          </Button>
        }
      />
      <PopoverContent className="w-80 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder={`Search ${collectionLabel(config, type).toLowerCase()}…`} value={search} onValueChange={setSearch} />
          <CommandList>
            {results.isLoading ? <Delayed><div className="flex justify-center p-4"><Spinner /></div></Delayed> : <CommandEmpty>Nothing found.</CommandEmpty>}
            <CommandGroup>
              {results.data?.docs.map(doc => (
                <CommandItem
                  key={doc.id}
                  value={doc.id}
                  data-checked={selected?.id === doc.id}
                  onSelect={() => {
                    onSelect(doc.id);
                    setOpen(false);
                  }}
                >
                  <StatusDot status={(doc.$meta as { status: "draft" } | undefined)?.status} />
                  <span className="min-w-0 flex-1 truncate">{documentTitle(config, type, doc)}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// --- Assets ----------------------------------------------------------------------

export function useAsset(id: string | undefined) {
  const { cms } = useAdmin();
  return useQuery({ queryKey: ["asset", id], enabled: Boolean(id), queryFn: () => cms.assets.get(id!), retry: false });
}

export function useUpload() {
  const { cms, site } = useAdmin();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);

  /**
   * Uploads files one after another, asking first whether to remove location and camera details
   * when any photo has them. Null when that's cancelled; the files that uploaded otherwise.
   */
  async function uploadFiles(files: Array<File | DroppedFile>, options?: Parameters<typeof cms.upload>[1], prepare?: () => Promise<unknown>, folders: string[] = []): Promise<Asset[] | null> {
    // A file from a dropped folder goes into that folder, inside `options.folder`.
    const list = files.map(f => (f instanceof File ? { file: f, folder: null } : f));
    const strip = await chooseStripMetadata(list, site.stripMetadata ?? true, folders);
    if(strip === null) return null;
    // Runs once the upload is confirmed: making a dropped folder's folders, say.
    await prepare?.();
    setUploading(true);
    const uploaded: Asset[] = [];
    try {
      for(const { file, folder } of list) {
        try {
          const into = folder ? [options?.folder, folder].filter(Boolean).join("/") : options?.folder;
          const choice = strip?.get(file);
          const asset = await cms.upload(file, { ...options, folder: into, ...(choice === undefined ? {} : { stripMetadata: choice }) });
          queryClient.setQueryData(["asset", asset.id], asset);
          uploaded.push(asset);
        } catch (error) {
          cms.toast(error instanceof ApiError ? error.message : `Couldn't upload ${file.name}`, { type: "error" });
        }
      }
      if(uploaded.length) await queryClient.invalidateQueries({ queryKey: ["assets"] });
      return uploaded;
    } finally {
      setUploading(false);
    }
  }

  /** One file; says so when its details were removed, since nothing else confirms it. */
  async function upload(file: File, options?: Parameters<typeof cms.upload>[1]): Promise<Asset | null> {
    const asset = (await uploadFiles([file], options))?.[0] ?? null;
    if(asset?.meta.metadataRemoved) cms.toast(`Removed location and camera details from ${asset.filename}`, { type: "success" });
    return asset;
  }
  return { upload, uploadFiles, uploading };
}

export function AssetControl({ schema, value, onChange, path, issues, readOnly, doc, optional, field, options }: PickerProps & { options: AssetPickerOptions }) {
  const s = schema as AssetSchema;
  const usage = value && typeof value === "object" ? value as DocumentData & { asset: string } : undefined;
  const asset = useAsset(usage?.asset);
  const { upload, uploading } = useUpload();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  function choose(next: Asset) {
    const keep = { ...usage };
    delete keep.asset;
    onChange({ ...keep, asset: next.id });
  }

  async function handleFile(file: File | undefined) {
    if(!file) return;
    const uploaded = await upload(file, { type: doc.type, field: path.join("."), folder: s.folder });
    if(uploaded) choose(uploaded);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if(!readOnly) void handleFile(event.dataTransfer.files[0]);
  }

  const focal = usage?.focal as { x: number, y: number } | undefined;
  const fieldEntries = Object.entries(s.fields).filter(([key]) => !(key === "focal" && options.focal));

  return (
    <div className="flex flex-col gap-3">
      <input ref={fileInput} type="file" hidden accept={s.accept?.join(",")} onChange={e => {
        void handleFile(e.target.files?.[0]);
        e.target.value = "";
      }} />
      <div
        id={fieldId(path)}
        onDragOver={e => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-[16px] well transition-shadow sm:flex-row",
          dragging && "shadow-[inset_0_0_0_2px_var(--brand)]",
          field.errors.length > 0 && "shadow-[inset_0_0_0_1px_var(--destructive),var(--shadow-well)]"
        )}
      >
        {usage ? (
          <>
            <div className="relative flex shrink-0 items-center justify-center bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] sm:w-64">
              {asset.isLoading ? <div className="aspect-video w-full animate-pulse bg-muted" />
                : asset.data ? (
                  <AssetPreview
                    asset={asset.data}
                    focal={options.focal && !readOnly ? focal : undefined}
                    onFocal={options.focal && !readOnly ? next => onChange({ ...usage, focal: next }) : undefined}
                  />
                ) : <div className="p-6 text-sm text-destructive">This file no longer exists</div>}
            </div>
            <div className="flex min-w-0 flex-1 flex-col justify-between gap-3 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{asset.data?.filename ?? usage.asset}</p>
                {asset.data && <p className="text-xs text-muted-foreground">{describeAsset(asset.data)}</p>}
                {options.focal && !readOnly && asset.data?.mime.startsWith("image/") && (
                  <p className="mt-1 text-xs text-muted-foreground">Click the image to set its focal point{focal ? ` (${Math.round(focal.x * 100)}%, ${Math.round(focal.y * 100)}%)` : ""}.</p>
                )}
              </div>
              {!readOnly && (
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={uploading}>
                    {uploading ? <Spinner /> : <UploadIcon />} Replace
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setLibraryOpen(true)}><LibraryIcon /> Library</Button>
                  <Button size="sm" variant="ghost" onClick={() => onChange(undefined)} aria-label="Remove file"><XIcon /> Remove</Button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex w-full flex-col items-center gap-3 px-4 py-8 text-center">
            <div className="flex size-10 items-center justify-center rounded-full raised">
              {s.accept?.every(a => a.startsWith("image/")) ? <ImageIcon className="size-4" /> : s.accept?.every(a => a.startsWith("video/")) ? <FilmIcon className="size-4" /> : <FileIcon className="size-4" />}
            </div>
            <div>
              <p className="text-sm font-medium">{readOnly ? "No file" : "Drop a file here"}</p>
              {!readOnly && <p className="text-xs text-muted-foreground">{acceptLabel(s)}</p>}
            </div>
            {!readOnly && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? <Spinner /> : <UploadIcon />} Upload</Button>
                <Button size="sm" variant="outline" onClick={() => setLibraryOpen(true)}><LibraryIcon /> Choose from library</Button>
              </div>
            )}
          </div>
        )}
      </div>
      {usage && fieldEntries.length > 0 && (
        <div className="flex flex-col gap-4 pl-1">
          {fieldEntries.map(([key, fieldSchema]) => (
            <Field
              key={key}
              schema={fieldSchema}
              name={key}
              path={[...path, key]}
              value={usage[key]}
              issues={issues}
              readOnly={readOnly}
              doc={doc}
              onChange={next => {
                const copy = { ...usage };
                if(next === undefined) delete copy[key];
                else copy[key] = next;
                onChange(copy);
              }}
            />
          ))}
        </div>
      )}
      <MediaLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        accept={s.accept}
        folder={s.folder}
        onSelect={next => {
          choose(next);
          setLibraryOpen(false);
        }}
      />
      {optional ? null : null}
    </div>
  );
}

function acceptLabel(schema: AssetSchema): string {
  const parts: string[] = [];
  if(schema.accept?.length) {
    parts.push(schema.accept.map(a => (a.endsWith("/*") ? `${a.slice(0, -2)}s` : a.split("/")[1]?.toUpperCase() ?? a)).join(", "));
  }
  if(schema.maxSize) parts.push(`up to ${formatBytes(schema.maxSize)}`);
  return parts.length ? humanize(parts.join(" · ")) : "Any file";
}

export function formatBytes(bytes: number): string {
  if(bytes >= 1e9) return `${+(bytes / 1e9).toFixed(1)} GB`;
  if(bytes >= 1e6) return `${+(bytes / 1e6).toFixed(1)} MB`;
  if(bytes >= 1e3) return `${+(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function describeAsset(asset: Asset): string {
  // The extension reads better than the MIME subtype ("TXT", not "PLAIN"; "SVG", not "SVG+XML").
  const extension = /\.([a-z0-9]{1,6})$/i.exec(asset.filename)?.[1];
  const parts = [(extension ?? asset.mime.split("/")[1] ?? asset.mime).toUpperCase(), formatBytes(asset.size)];
  if(asset.meta.width && asset.meta.height) parts.push(`${asset.meta.width}×${asset.meta.height}`);
  if(asset.meta.duration) parts.push(`${Math.round(asset.meta.duration)}s`);
  return parts.join(" · ");
}

export function AssetPreview({ asset, focal, onFocal, className }: {
  asset: Asset,
  focal?: { x: number, y: number },
  onFocal?: (focal: { x: number, y: number }) => void,
  className?: string
}) {
  if(asset.mime.startsWith("image/")) {
    return (
      <div className={cn("relative", className)}>
        <img
          src={asset.url}
          alt=""
          draggable={false}
          className={cn("block max-h-64 w-full object-contain", onFocal && "cursor-crosshair")}
          onClick={event => {
            if(!onFocal) return;
            const rect = event.currentTarget.getBoundingClientRect();
            onFocal({
              x: Math.round(((event.clientX - rect.left) / rect.width) * 1000) / 1000,
              y: Math.round(((event.clientY - rect.top) / rect.height) * 1000) / 1000
            });
          }}
        />
        {focal && (
          <span
            className="pointer-events-none absolute size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.4),0_2px_6px_rgba(0,0,0,.4)]"
            style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
          />
        )}
      </div>
    );
  }
  if(asset.mime.startsWith("video/")) return <video src={asset.url} controls className={cn("max-h-64 w-full", className)} />;
  return (
    <div className={cn("flex flex-col items-center gap-2 p-6 text-muted-foreground", className)}>
      <FileIcon className="size-8" />
      <span className="text-xs">{asset.mime}</span>
    </div>
  );
}

export function AssetThumb({ asset, selected, onClick, style, folder, nav }: {
  asset: Asset,
  /** A row for the media library's arrow keys. */
  nav?: boolean,
  selected?: boolean,
  onClick?(event: React.MouseEvent): void,
  style?: CSSProperties,
  /** Shown above the details, e.g. where a search result lives. */
  folder?: string
}) {
  return (
    <button
      type="button"
      data-nav={nav ? "file" : undefined}
      onClick={onClick}
      style={style}
      className={cn(
        "group/thumb flex flex-col overflow-hidden rounded-[14px] elevated text-left transition-[box-shadow,scale] duration-150 hover:shadow-(--shadow-raised-hover) active:scale-[0.98] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected && "shadow-[0_0_0_2px_var(--brand),var(--shadow-card)]"
      )}
    >
      <div className="flex aspect-[4/3] items-center justify-center overflow-hidden bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:12px_12px]">
        {asset.mime.startsWith("image/") ? (
          <img src={asset.url} alt="" loading="lazy" className="size-full object-cover transition-transform group-hover/thumb:scale-[1.03]" />
        ) : asset.mime.startsWith("video/") ? (
          <FilmIcon className="size-8 text-muted-foreground" />
        ) : (
          <FileIcon className="size-8 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 px-2.5 py-2">
        <p className="truncate text-xs font-medium">{asset.filename}</p>
        {folder && <p className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground"><FolderIcon className="size-3 shrink-0" /><span className="truncate">{folder}</span></p>}
        <p className="truncate text-[11px] text-muted-foreground">{describeAsset(asset)}</p>
      </div>
    </button>
  );
}

const LAST_FOLDER_KEY = "vibe:library-folder";

/** The folder the dialog was last left in, so picking several files in a row doesn't start over each time. */
function lastFolder(): string | null {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) || null;
  } catch {
    return null;
  }
}

function rememberFolder(folder: string | null) {
  try {
    if(folder) localStorage.setItem(LAST_FOLDER_KEY, folder);
    else localStorage.removeItem(LAST_FOLDER_KEY);
  } catch {}
}

/** `"a/b"` → `["a", "a/b"]`, for the breadcrumb. */
function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Picking a file: browse folders like the media library's Folders view (a breadcrumb, then the
 * folder's subfolders and files), or search every folder. Opens in the field's folder, else where
 * it was last left.
 */
export function MediaLibraryDialog({ open, onOpenChange, accept, folder, onSelect }: {
  open: boolean,
  onOpenChange(open: boolean): void,
  accept?: string[],
  /** The field's folder: where the dialog opens and uploads go. */
  folder?: string,
  onSelect(asset: Asset): void
}) {
  const { cms } = useAdmin();
  const [search, setSearch] = useState("");
  // null is the top level, "All files".
  const [current, setCurrent] = useState<string | null>(() => folder ?? lastFolder());
  const [wasOpen, setWasOpen] = useState(open);
  if(open !== wasOpen) {
    setWasOpen(open);
    // Each time it opens: the field's folder, else the last one, and no leftover search.
    if(open) {
      setCurrent(folder ?? lastFolder());
      setSearch("");
    }
  }
  const { upload, uploading } = useUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const searching = search.trim().length > 0;
  const list = useQuery({
    queryKey: ["assets", { search: searching ? search : undefined, folder: searching ? undefined : current ?? "", accept }],
    enabled: open,
    queryFn: () => cms.assets.list(searching
      ? { search, accept, limit: 120 }
      : { folder: current ?? "", accept, limit: 120 })
  });
  // Counted by the types this field accepts, so a tile's number matches what opening it shows.
  const folders = useQuery({
    queryKey: ["folders", { accept }],
    enabled: open,
    queryFn: () => cms.actions.folders.list({ accept })
  });
  const all = folders.data?.folders ?? [];
  const exists = current === null || all.some(f => f.path === current);
  const children = searching ? [] : all.filter(f => f.path !== current && (current === null ? !f.path.includes("/") : f.path.startsWith(`${current}/`) && !f.path.slice(current.length + 1).includes("/")));
  /** Files in a folder and everything under it, for its tile. */
  function countIn(path: string): number {
    return all.filter(f => f.path === path || f.path.startsWith(`${path}/`)).reduce((n, f) => n + f.files, 0);
  }

  function go(next: string | null) {
    setCurrent(next);
    setSearch("");
    rememberFolder(next);
  }

  function pick(asset: Asset) {
    rememberFolder(asset.folder);
    onSelect(asset);
  }

  const assets = list.data?.assets ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* A fixed height: moving between folders mustn't resize the dialog and shift it under the pointer. */}
      <DialogContent className="flex h-[min(85vh,44rem)] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Media library</DialogTitle>
          <DialogDescription>Pick a file{accept?.length ? ` (${accept.join(", ")})` : ""}, or upload a new one.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search all folders" className="pl-8" />
          </div>
          <input ref={fileInput} type="file" hidden accept={accept?.join(",")} onChange={async e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if(!file) return;
            const asset = await upload(file, { folder: current ?? undefined });
            if(asset) pick(asset);
          }} />
          <Button onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? <Spinner /> : <UploadIcon />} Upload</Button>
        </div>

        {searching ? (
          <p className="-mt-1 px-1 text-sm text-muted-foreground">Results from every folder</p>
        ) : (
          <nav aria-label="Folder" className="-mt-1 -ml-1.5 min-w-0 text-sm text-muted-foreground">
            <CollapsedPath
              items={[null, ...(current ? ancestors(current) : [])] as Array<string | null>}
              label={path => (path === null ? "All files" : path.slice(path.lastIndexOf("/") + 1))}
              separator={<ChevronRightIcon className="mx-0.5 size-3.5 opacity-50" />}
              onOpen={go}
              renderItem={(path, last) => (
                <button
                  type="button"
                  disabled={last}
                  onClick={() => go(path)}
                  title={path ?? undefined}
                  className={cn("truncate rounded-[8px] px-1.5 py-1", last ? "font-medium text-foreground" : "hover:bg-foreground/[0.05] hover:text-foreground")}
                >
                  {path === null ? "All files" : path.slice(path.lastIndexOf("/") + 1)}
                </button>
              )}
            />
          </nav>
        )}

        {/* Bleeds into the dialog's padding so tile shadows (and their hover lift) aren't clipped by the scroll area. */}
        <div className="-mx-3 -mt-2 -mb-3 min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-3">
          {list.isLoading ? (
            <Delayed><div className="flex justify-center p-10"><Spinner /></div></Delayed>
          ) : children.length || assets.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {children.map(child => (
                <button
                  key={child.path}
                  type="button"
                  onClick={() => go(child.path)}
                  className="flex items-center gap-2.5 rounded-[14px] elevated px-3 py-2.5 text-left transition-[box-shadow,scale] duration-150 hover:shadow-(--shadow-raised-hover) active:scale-[0.98] focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{child.path.slice(child.path.lastIndexOf("/") + 1)}</span>
                    <span className="block text-[11px] text-muted-foreground">{countIn(child.path) === 1 ? "1 file" : `${countIn(child.path)} files`}</span>
                  </span>
                </button>
              ))}
              {/* A folder tile row stays its own row: files start on the next line. */}
              {children.length > 0 && assets.length > 0 && <div className="col-span-full -my-1" />}
              {assets.map(asset => <AssetThumb key={asset.id} asset={asset} folder={searching ? asset.folder ?? "All files" : undefined} onClick={() => pick(asset)} />)}
            </div>
          ) : (
            <p className="p-10 text-center text-sm text-muted-foreground">
              {searching ? `Nothing matches “${search.trim()}”.` : exists ? "Nothing in this folder yet." : "This folder doesn't exist yet. Uploads will create it."}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return <Badge variant="outline" className="font-normal">{children}</Badge>;
}
