import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, CopyIcon, FileTextIcon, FolderIcon, ImageIcon, PlusIcon, SearchIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import type { Asset, DocumentSummary } from "../index.ts";
import type { DocumentData } from "../../schema/types.ts";
import { Button } from "../components/ui/button.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Input } from "../components/ui/input.tsx";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { cn } from "../lib/utils.ts";
import { ApiError } from "./client.ts";
import { Delayed } from "./delayed.tsx";
import { ShaderBackdrop } from "./texture.tsx";
import { collectionLabel, collectionSettings, documentTitle, formatDate, formatRelative, localeName, titleField, useAdmin } from "./context.tsx";
import { EditorPage } from "./editor.tsx";
import { AssetPreview, AssetThumb, describeAsset, FolderSelect, useUpload } from "./pickers.tsx";
import { Link, navigate, useLocation } from "./router.tsx";
import { StatusBadge, StatusDot } from "./status.tsx";

const PAGE = 25;

/** Position in a `.stagger` list (see styles.css). */
export function staggerIndex(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ListPage({ type }: { type: string }) {
  const { cms, config, locale, session, plugins } = useAdmin();
  const { search: params } = useLocation();
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const page = Number(params.get("page") ?? 0);
  const sort = params.get("sort") ?? "-$updatedAt";
  const settings = collectionSettings(config, type);
  const label = collectionLabel(config, type);
  const titleKey = titleField(config, type);
  const canWrite = session.permissions.types[type]?.write;
  const columns = plugins.slots["list.columns"]!.filter(c => c.type === type);

  const list = useQuery({
    queryKey: ["documents", type, locale, query, page, sort],
    queryFn: () => cms.api<{ docs: DocumentSummary[], total: number }>(
      `/documents/${type}?${new URLSearchParams({ locale, search: query, limit: String(PAGE), offset: String(page * PAGE), sort })}`
    ),
    placeholderData: keepPreviousData
  });

  useEffect(() => {
    document.title = `${label} · ${config.name ?? "Editor"}`;
  }, [label]);

  // Singletons open their one document directly.
  useEffect(() => {
    if(!settings.singleton || !list.data) return;
    const only = list.data.docs[0];
    navigate(only ? `/content/${type}/${only.id}` : `/content/${type}/new`, { replace: true });
  }, [settings.singleton, list.data]);

  if(settings.singleton) return <Delayed><div className="flex justify-center p-16"><Spinner /></div></Delayed>;

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params);
    if(value === null) next.delete(key);
    else next.set(key, value);
    navigate(`/content/${type}?${next}`, { replace: true });
  }

  function sortBy(field: string) {
    setParam("sort", sort === `-${field}` ? field : `-${field}`);
  }

  function SortHead({ field, children, className }: { field: string, children: string, className?: string }) {
    const active = sort.replace(/^-/, "") === field;
    return (
      <TableHead className={className}>
        <button className="inline-flex items-center gap-1 hover:text-foreground" onClick={() => sortBy(field)}>
          {children}
          {active && (sort.startsWith("-") ? <ArrowDownIcon className="size-3" /> : <ArrowUpIcon className="size-3" />)}
        </button>
      </TableHead>
    );
  }

  const total = list.data?.total ?? 0;
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="eyebrow">Content{config.locales!.length > 1 ? ` · ${localeName(locale)}` : ""}</p>
          <h1 className="text-2xl font-medium tracking-[-0.025em]">{label}</h1>
          <p className="text-sm text-muted-foreground">
            {list.data ? `${total} ${total === 1 ? "document" : "documents"}` : " "}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search" className="w-56 pl-8" aria-label={`Search ${label}`} />
          </div>
          {canWrite && (
            <Button nativeButton={false} render={<Link to={`/content/${type}/new`} />}>
              <PlusIcon /> New
            </Button>
          )}
        </div>
      </div>

      {list.isLoading ? (
        <Delayed><div className="space-y-2">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div></Delayed>
      ) : list.isError ? (
        <p className="text-sm text-destructive">{(list.error as Error).message}</p>
      ) : total === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
            <EmptyTitle>{query ? "No matches" : `No ${label.toLowerCase()} yet`}</EmptyTitle>
            <EmptyDescription>{query ? "Try a different search." : canWrite ? "Create the first one." : "Nothing has been written here yet."}</EmptyDescription>
          </EmptyHeader>
          {canWrite && !query && (
            <EmptyContent>
              <Button nativeButton={false} render={<Link to={`/content/${type}/new`} />}><PlusIcon /> New {collectionLabel(config, type, false).toLowerCase()}</Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <div className={cn("overflow-hidden rounded-xl border bg-card transition-opacity", list.isPlaceholderData && "opacity-60")}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent [&_th]:eyebrow [&_th]:h-9">
                {titleKey ? <SortHead field={titleKey} className="pl-4">Title</SortHead> : <TableHead className="pl-4">Document</TableHead>}
                <TableHead>Status</TableHead>
                {columns.map(c => <TableHead key={c.id}>{c.label}</TableHead>)}
                <SortHead field="$updatedAt" className="w-40 pr-4 text-right">Updated</SortHead>
              </TableRow>
            </TableHeader>
            <TableBody className="stagger">
              {list.data!.docs.map((doc, i) => (
                <TableRow key={doc.id} style={staggerIndex(i)} className="cursor-pointer" onClick={() => navigate(`/content/${type}/${doc.id}`)}>
                  <TableCell className="max-w-0 pl-4 font-medium">
                    <Link to={`/content/${type}/${doc.id}`} className="block truncate" onClick={e => e.stopPropagation()}>{documentTitle(config, type, doc)}</Link>
                    {doc.$meta.locale !== locale && <span className="text-xs font-normal text-muted-foreground">Not translated · showing {localeName(doc.$meta.locale)}</span>}
                  </TableCell>
                  <TableCell className="w-48">
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                      <StatusDot status={doc.$meta.status} />
                      {{ draft: "Draft", published: "Published", changed: "Changed" }[doc.$meta.status]}
                    </span>
                  </TableCell>
                  {columns.map(c => <TableCell key={c.id}><c.component doc={doc} cms={cms} /></TableCell>)}
                  <TableCell className="pr-4 text-right text-sm text-muted-foreground" title={formatDate(doc.$meta.updatedAt)}>{formatRelative(doc.$meta.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {total > PAGE && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{page * PAGE + 1}–{Math.min(total, (page + 1) * PAGE)} of {total}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setParam("page", String(page - 1))}>Previous</Button>
            <Button variant="outline" size="sm" disabled={(page + 1) * PAGE >= total} onClick={() => setParam("page", String(page + 1))}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DocumentRoute({ type, id }: { type: string, id: string }) {
  return <EditorPage key={`${type}/${id}`} type={type} id={id === "new" ? null : id} />;
}

export function Dashboard() {
  const { cms, config, locale, session, info } = useAdmin();
  const types = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  const stats = useQuery({
    queryKey: ["dashboard", locale],
    queryFn: async () => Promise.all(types.map(async type => {
      const result = await cms.api<{ docs: DocumentSummary[], total: number }>(`/documents/${type}?locale=${locale}&limit=5`);
      return { type, ...result };
    }))
  });
  useEffect(() => {
    document.title = config.name ?? info.site.name;
  }, []);
  const recent = (stats.data ?? [])
    .flatMap(s => s.docs.map(doc => ({ type: s.type, doc })))
    .sort((a, b) => b.doc.$meta.updatedAt.localeCompare(a.doc.$meta.updatedAt))
    .slice(0, 8);
  const writable = types.filter(t => session.permissions.types[t]?.write && !collectionSettings(config, t).singleton);
  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Working late" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-10 px-4 py-6 md:px-8">
      <header>
        <div className="relative overflow-hidden rounded-2xl border">
          <ShaderBackdrop />
          <div className="relative z-10 flex flex-wrap items-end justify-between gap-6 px-6 pt-14 pb-6 md:px-8">
            <div className="space-y-2">
              <p className="eyebrow">{location.host}</p>
              <h1 className="text-3xl font-medium tracking-[-0.03em] md:text-4xl">{config.name ?? info.site.name}</h1>
              <p className="text-sm text-muted-foreground">
                {greeting}{session.user.name ? `, ${session.user.name.split(" ")[0]}` : ""}.
              </p>
            </div>
            {writable.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {writable.slice(0, 3).map(type => (
                  <Button key={type} variant="outline" size="sm" className="bg-background/70 backdrop-blur" nativeButton={false} render={<Link to={`/content/${type}/new`} />}>
                    <PlusIcon /> {collectionLabel(config, type, false)}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Content</h2>
        <div className="stagger grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] overflow-hidden rounded-xl border [&>*]:-mr-px [&>*]:-mb-px [&>*]:border-r [&>*]:border-b">
          {types.map((type, i) => {
            const entry = stats.data?.find(s => s.type === type);
            const settings = collectionSettings(config, type);
            return (
              <Link
                key={type}
                to={`/content/${type}`}
                style={staggerIndex(i)}
                className="group/card relative flex flex-col gap-6 bg-card p-5 transition-colors duration-200 hover:bg-accent"
              >
                <span className="flex items-center justify-between text-sm text-muted-foreground">
                  {collectionLabel(config, type)}
                  <ArrowUpRightIcon className="size-4 opacity-0 transition-[opacity,translate] duration-200 group-hover/card:translate-x-0.5 group-hover/card:-translate-y-0.5 group-hover/card:opacity-100" />
                </span>
                <span className="text-3xl font-medium tracking-[-0.03em]">
                  {entry ? (settings.singleton ? (entry.total ? "Set" : "Not set") : entry.total) : <Delayed><Skeleton className="h-9 w-12" /></Delayed>}
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Recently edited</h2>
        <div className="stagger overflow-hidden rounded-xl border bg-card">
          {stats.isLoading ? <Delayed><div className="p-6"><Spinner /></div></Delayed>
            : recent.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Nothing yet. Pick a content type to start writing.</p>
              : recent.map(({ type, doc }, i) => (
                <Link
                  key={doc.id}
                  to={`/content/${type}/${doc.id}`}
                  style={staggerIndex(i)}
                  className="group/row flex items-center gap-3 border-b px-4 py-3 text-sm transition-colors last:border-b-0 hover:bg-accent"
                >
                  <StatusDot status={doc.$meta.status} />
                  <span className="min-w-0 flex-1 truncate font-medium">{documentTitle(config, type, doc)}</span>
                  <span className="text-xs text-muted-foreground">{collectionLabel(config, type, false)}</span>
                  <span className="w-28 text-right text-xs text-muted-foreground">{formatRelative(doc.$meta.updatedAt)}</span>
                </Link>
              ))}
        </div>
      </section>
    </div>
  );
}

export function MediaPage() {
  const { cms, session, config, info } = useAdmin();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [folder, setFolder] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const { upload, uploading } = useUpload();
  const fileInput = useRef<HTMLInputElement>(null);
  const query = useDebounced(search);
  const list = useQuery({
    queryKey: ["assets", { search: query, folder }],
    queryFn: () => cms.assets.list({ search: query || undefined, folder, limit: 200 }),
    placeholderData: keepPreviousData
  });
  useEffect(() => {
    document.title = `Media · ${config.name ?? info.site.name}`;
  }, []);

  async function uploadAll(files: FileList | File[]) {
    for(const file of Array.from(files)) await upload(file, { folder });
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if(session.permissions.media.write) void uploadAll(event.dataTransfer.files);
  }

  return (
    <div
      className={cn("mx-auto flex min-h-full w-full max-w-6xl flex-col gap-5 px-4 py-6 md:px-8", dragging && "bg-primary/5")}
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => e.currentTarget === e.target && setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="eyebrow">Library</p>
          <h1 className="text-2xl font-medium tracking-[-0.025em]">Media</h1>
          <p className="text-sm text-muted-foreground">{list.data ? `${list.data.total} files` : " "} · drop files anywhere to upload</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search files" className="w-52 pl-8" />
          </div>
          <FolderSelect folders={list.data?.folders ?? []} value={folder} onChange={setFolder} />
          {session.permissions.media.write && (
            <>
              <input ref={fileInput} type="file" multiple hidden onChange={e => {
                if(e.target.files) void uploadAll(e.target.files);
                e.target.value = "";
              }} />
              <Button onClick={() => fileInput.current?.click()} disabled={uploading}>{uploading ? <Spinner /> : <UploadIcon />} Upload</Button>
            </>
          )}
        </div>
      </div>
      {list.isLoading ? (
        <Delayed><div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">{Array.from({ length: 12 }, (_, i) => <Skeleton key={i} className="aspect-[4/3.6]" />)}</div></Delayed>
      ) : list.data?.assets.length ? (
        <div className="stagger grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {list.data.assets.map((asset, i) => <AssetThumb key={asset.id} style={staggerIndex(i)} asset={asset} selected={selected === asset.id} onClick={() => setSelected(asset.id)} />)}
        </div>
      ) : (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon"><ImageIcon /></EmptyMedia>
            <EmptyTitle>No files{folder ? " in this folder" : ""}</EmptyTitle>
            <EmptyDescription>Upload images, video and documents to use them in your content.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      <AssetSheet
        id={selected}
        onClose={() => setSelected(null)}
        onChanged={() => void queryClient.invalidateQueries({ queryKey: ["assets"] })}
      />
    </div>
  );
}

function AssetSheet({ id, onClose, onChanged }: { id: string | null, onClose(): void, onChanged(): void }) {
  const { cms, config, session } = useAdmin();
  const queryClient = useQueryClient();
  const asset = useQuery({
    queryKey: ["asset-detail", id],
    enabled: id !== null,
    queryFn: () => cms.api<Asset & { usage: Array<{ id: string, type: string, locale: string }> }>(`/assets/${id}`)
  });
  const [filename, setFilename] = useState("");
  const [folder, setFolder] = useState("");
  useEffect(() => {
    if(asset.data) {
      setFilename(asset.data.filename);
      setFolder(asset.data.folder ?? "");
    }
  }, [asset.data]);
  const data = asset.data;
  const changed = data && (filename !== data.filename || folder !== (data.folder ?? ""));
  return (
    <Sheet open={id !== null} onOpenChange={open => !open && onClose()}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="truncate pr-6">{data?.filename ?? "File"}</SheetTitle>
          <SheetDescription>{data ? describeAsset(data) : " "}</SheetDescription>
        </SheetHeader>
        {data ? (
          <div className="flex flex-col gap-5 overflow-y-auto px-4">
            <div className="overflow-hidden rounded-xl border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
              <AssetPreview asset={data} />
            </div>
            <div className="flex items-center gap-2">
              <Input readOnly value={new URL(data.url, location.href).href} className="font-mono text-xs" onFocus={e => e.target.select()} />
              <Button variant="outline" size="icon" aria-label="Copy URL" onClick={() => {
                void navigator.clipboard.writeText(new URL(data.url, location.href).href);
                cms.toast("URL copied");
              }}><CopyIcon /></Button>
            </div>
            <label className="grid gap-1.5 text-sm font-medium">
              File name
              <Input value={filename} onChange={e => setFilename(e.target.value)} readOnly={!session.permissions.media.write} />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              <span className="flex items-center gap-1.5"><FolderIcon className="size-3.5" /> Folder</span>
              <Input value={folder} onChange={e => setFolder(e.target.value)} placeholder="No folder" readOnly={!session.permissions.media.write} />
            </label>
            <div className="grid gap-2">
              <h4 className="text-sm font-medium">Used in</h4>
              {data.usage.length === 0 ? <p className="text-sm text-muted-foreground">Not used by any document.</p> : (
                <ul className="grid gap-1 text-sm">
                  {data.usage.map(u => (
                    <li key={`${u.id}/${u.locale}`}>
                      <UsageLink type={u.type} id={u.id} locale={u.locale} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Uploaded {formatDate(data.createdAt)}</p>
            <span className="sr-only">{Object.keys(config.schemas).length}</span>
          </div>
        ) : <Delayed><div className="flex justify-center p-8"><Spinner /></div></Delayed>}
        <SheetFooter className="flex-row justify-between">
          {session.permissions.media.delete && (
            <Button variant="ghost" className="text-destructive" disabled={!data || data.usage.length > 0} onClick={async () => {
              try {
                await cms.api(`/assets/${id}`, { method: "DELETE" });
                cms.toast("File deleted", { type: "success" });
                onChanged();
                onClose();
              } catch (error) {
                cms.toast(error instanceof ApiError ? error.message : "Couldn't delete", { type: "error" });
              }
            }}><Trash2Icon /> Delete</Button>
          )}
          {session.permissions.media.write && (
            <Button disabled={!changed} onClick={async () => {
              await cms.api(`/assets/${id}`, { method: "PATCH", json: { filename, folder: folder || null } });
              void queryClient.invalidateQueries({ queryKey: ["asset-detail", id] });
              void queryClient.invalidateQueries({ queryKey: ["asset", id] });
              onChanged();
              cms.toast("Saved", { type: "success" });
            }}>Save</Button>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function UsageLink({ type, id, locale }: { type: string, id: string, locale: string }) {
  const { cms, config } = useAdmin();
  const doc = useQuery({
    queryKey: ["document", type, id, locale],
    queryFn: () => cms.api<{ draft: DocumentData | null, status: "draft" }>(`/documents/${type}/${id}?locale=${locale}`)
  });
  return (
    <Link to={`/content/${type}/${id}?locale=${locale}`} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-muted">
      <StatusDot status={doc.data?.status} />
      <span className="truncate">{doc.data ? documentTitle(config, type, doc.data.draft) : "…"}</span>
      <span className="ml-auto text-xs text-muted-foreground">{collectionLabel(config, type, false)}{config.locales!.length > 1 ? ` · ${locale}` : ""}</span>
    </Link>
  );
}

export { StatusBadge };
