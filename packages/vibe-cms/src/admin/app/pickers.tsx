import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDownIcon, ExternalLinkIcon, FileIcon, FilmIcon, ImageIcon, LibraryIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react";
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

interface DocumentState {
  id: string,
  draft: DocumentData | null,
  fallback: DocumentData | null,
  status: "draft" | "published" | "changed" | null
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
    queryFn: () => cms.api<DocumentState>(`/documents/${type}/${id}?locale=${locale}`),
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
  const { cms } = useAdmin();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  async function upload(file: File, options?: Parameters<typeof cms.upload>[1]): Promise<Asset | null> {
    setUploading(true);
    try {
      const asset = await cms.upload(file, options);
      queryClient.setQueryData(["asset", asset.id], asset);
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      return asset;
    } catch (error) {
      cms.toast(error instanceof ApiError ? error.message : "Upload failed", { type: "error" });
      return null;
    } finally {
      setUploading(false);
    }
  }
  return { upload, uploading };
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
          "relative flex flex-col overflow-hidden rounded-xl border bg-muted/30 transition-colors sm:flex-row",
          dragging && "border-primary bg-primary/5",
          field.errors.length > 0 && "border-destructive/60"
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
            <div className="flex size-10 items-center justify-center rounded-full bg-background shadow-sm ring-1 ring-border">
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
  const parts = [asset.mime.split("/")[1]?.toUpperCase() ?? asset.mime, formatBytes(asset.size)];
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

export function AssetThumb({ asset, selected, onClick, style }: { asset: Asset, selected?: boolean, onClick?(): void, style?: CSSProperties }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      className={cn(
        "group/thumb flex flex-col overflow-hidden rounded-lg border bg-card text-left transition-shadow hover:shadow-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
        selected && "ring-2 ring-primary"
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
      <div className="min-w-0 border-t px-2 py-1.5">
        <p className="truncate text-xs font-medium">{asset.filename}</p>
        <p className="truncate text-[11px] text-muted-foreground">{describeAsset(asset)}</p>
      </div>
    </button>
  );
}

export function MediaLibraryDialog({ open, onOpenChange, accept, folder, onSelect }: {
  open: boolean,
  onOpenChange(open: boolean): void,
  accept?: string[],
  folder?: string,
  onSelect(asset: Asset): void
}) {
  const { cms } = useAdmin();
  const [search, setSearch] = useState("");
  const [currentFolder, setCurrentFolder] = useState<string | undefined>(folder);
  const { upload, uploading } = useUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const list = useQuery({
    queryKey: ["assets", { search, folder: currentFolder, accept }],
    enabled: open,
    queryFn: () => cms.assets.list({ search: search || undefined, folder: currentFolder, accept, limit: 120 })
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Media library</DialogTitle>
          <DialogDescription>Pick a file{accept?.length ? ` (${accept.join(", ")})` : ""}, or upload a new one.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-48 flex-1">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search by file name" className="pl-8" />
          </div>
          <FolderSelect folders={list.data?.folders ?? []} value={currentFolder} onChange={setCurrentFolder} />
          <input ref={fileInput} type="file" hidden accept={accept?.join(",")} onChange={async e => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if(!file) return;
            const asset = await upload(file, { folder: currentFolder ?? folder });
            if(asset) onSelect(asset);
          }} />
          <Button onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? <Spinner /> : <UploadIcon />} Upload</Button>
        </div>
        <div className="-mx-1 min-h-48 overflow-y-auto px-1">
          {list.isLoading ? (
            <Delayed><div className="flex justify-center p-10"><Spinner /></div></Delayed>
          ) : list.data?.assets.length ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {list.data.assets.map(asset => <AssetThumb key={asset.id} asset={asset} onClick={() => onSelect(asset)} />)}
            </div>
          ) : (
            <p className="p-10 text-center text-sm text-muted-foreground">No files here yet.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FolderSelect({ folders, value, onChange }: { folders: string[], value: string | undefined, onChange(folder: string | undefined): void }) {
  const all = value && !folders.includes(value) ? [...folders, value] : folders;
  return (
    <Select
      items={[{ value: "*", label: "All folders" }, { value: "", label: "No folder" }, ...all.map(f => ({ value: f, label: f }))]}
      value={value === undefined ? "*" : value}
      onValueChange={next => onChange(next === "*" ? undefined : next as string)}
    >
      <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="*">All folders</SelectItem>
        <SelectItem value="">No folder</SelectItem>
        {all.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function Pill({ children }: { children: ReactNode }) {
  return <Badge variant="outline" className="font-normal">{children}</Badge>;
}
