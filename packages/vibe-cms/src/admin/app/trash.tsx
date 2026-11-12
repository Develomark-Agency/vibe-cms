import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileTextIcon, ImageIcon, RotateCcwIcon, Trash2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { TrashDetail, TrashItem } from "../../handler/engine.ts";
import type { Asset } from "../index.ts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from "../components/ui/alert-dialog.tsx";
import { Button } from "../components/ui/button.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "../components/ui/sheet.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { cn } from "../lib/utils.ts";
import { ApiError, requestBlob } from "./client.ts";
import { collectionLabel, collectionSchema, displayUser, formatDate, formatRelative, localeName, useAdmin } from "./context.tsx";
import { Delayed, useArrival } from "./delayed.tsx";
import { Field, FormValueContext } from "./fields.tsx";
import { staggerIndex } from "./pages.tsx";
import { AssetPreview, describeAsset } from "./pickers.tsx";
import { Page, PageHeader } from "./page.tsx";
import { navigate } from "./router.tsx";
import { Segmented } from "./segmented.tsx";
import { StatusDot } from "./status.tsx";
import { assetTextKind, TextPreview } from "./text-file.tsx";

/** Where a restored item lives now. */
function restoredPath(item: Pick<TrashItem, "kind" | "type" | "itemId" | "locale">): string {
  if(item.kind === "asset") return `/media?file=${item.itemId}`;
  return `/content/${item.type}/${item.itemId}${item.locale ? `?locale=${item.locale}` : ""}`;
}

type Pending = { kind: "purge", item: TrashItem } | { kind: "empty" };

export function TrashPage() {
  const { cms, config, session, site } = useAdmin();
  const queryClient = useQueryClient();
  const trash = useQuery({ queryKey: ["trash"], queryFn: () => cms.actions.trash.list() });
  const arrival = useArrival(!trash.isLoading);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [previewing, setPreviewing] = useState<TrashItem | null>(null);

  useEffect(() => {
    document.title = `Trash · ${site.name}`;
  }, [site.name]);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["trash"] });
    void queryClient.invalidateQueries({ queryKey: ["documents"] });
    void queryClient.invalidateQueries({ queryKey: ["document"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    void queryClient.invalidateQueries({ queryKey: ["folders"] });
  }

  async function run(key: string, action: () => Promise<void>) {
    setBusy(key);
    try {
      await action();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Something went wrong");
    } finally {
      setBusy(null);
      refresh();
    }
  }

  function restore(item: TrashItem) {
    setPreviewing(null);
    return run(item.id, async () => {
      await cms.actions.trash.restore({ id: item.id });
      toast.success(`Restored ${quote(item.label)}`, { action: { label: "Open", onClick: () => navigate(restoredPath(item)) } });
    });
  }

  function confirm() {
    const target = pending;
    setPending(null);
    setPreviewing(null);
    if(target?.kind === "purge") {
      void run(target.item.id, async () => {
        await cms.actions.trash.purge({ id: target.item.id });
        toast.success(`Deleted ${quote(target.item.label)} for good`);
      });
    } else if(target?.kind === "empty") {
      void run("empty", async () => {
        const { purged } = await cms.actions.trash.empty();
        toast.success(`Deleted ${purged} ${purged === 1 ? "item" : "items"} for good`);
      });
    }
  }

  function what(item: TrashItem): string {
    if(item.kind === "asset") return "File";
    const label = collectionLabel(config, item.type!, false);
    return item.locale ? `${label} · ${localeName(item.locale)} translation` : label;
  }

  const items = trash.data?.items ?? [];
  return (
    <Page>
      <PageHeader
        eyebrow="Site"
        title="Trash"
        summary={trash.data ? `Deleted items are kept for ${trash.data.days} ${trash.data.days === 1 ? "day" : "days"}, then removed for good.` : undefined}
        actions={items.length > 0 && (
          <Button variant="outline" className="text-destructive" disabled={busy !== null} onClick={() => setPending({ kind: "empty" })}>
            {busy === "empty" ? <Spinner /> : <Trash2Icon />} Empty trash
          </Button>
        )}
      />

      {trash.isLoading ? (
        <Delayed><div className="space-y-2">{Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-11 w-full" />)}</div></Delayed>
      ) : trash.isError ? (
        <p className="text-sm text-destructive">{(trash.error as Error).message}</p>
      ) : items.length === 0 ? (
        <Empty className="rounded-[16px] well">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Trash2Icon /></EmptyMedia>
            <EmptyTitle>The trash is empty</EmptyTitle>
            <EmptyDescription>Deleted documents and files show up here, and can be restored until they expire.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className={cn("overflow-hidden rounded-[16px] elevated", arrival)}>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent [&_th]:eyebrow [&_th]:h-9">
                <TableHead className="pl-4">Item</TableHead>
                <TableHead className="w-44">Deleted</TableHead>
                <TableHead className="w-36">Expires</TableHead>
                <TableHead className="w-52 pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody className="stagger">
              {items.map((item, i) => (
                <TableRow key={item.id} style={staggerIndex(i)} className="cursor-pointer" onClick={() => setPreviewing(item)}>
                  <TableCell className="max-w-0 pl-4">
                    <div className="flex min-w-0 items-center gap-2.5">
                      {item.kind === "asset" ? <ImageIcon className="size-4 shrink-0 text-muted-foreground" /> : <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />}
                      <div className="min-w-0">
                        <button type="button" className="block max-w-full truncate text-left font-medium" onClick={event => {
                          event.stopPropagation();
                          setPreviewing(item);
                        }}>{item.label}</button>
                        <div className="truncate text-xs text-muted-foreground">{what(item)}</div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground" title={formatDate(item.deletedAt)}>
                    {formatRelative(item.deletedAt)}
                    <div className="text-xs">by {displayUser(item.deletedBy, session)}</div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground" title={formatDate(item.expiresAt)}>{formatRelative(item.expiresAt)}</TableCell>
                  <TableCell className="pr-4">
                    <div className="flex justify-end gap-1.5" onClick={event => event.stopPropagation()}>
                      <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void restore(item)}>
                        {busy === item.id ? <Spinner /> : <RotateCcwIcon />} Restore
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={busy !== null} onClick={() => setPending({ kind: "purge", item })} aria-label={`Delete ${item.label} for good`} title="Delete for good">
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <TrashPreview
        item={previewing}
        busy={busy !== null}
        onOpenChange={open => !open && setPreviewing(null)}
        onRestore={item => void restore(item)}
        onPurge={item => setPending({ kind: "purge", item })}
      />

      <AlertDialog open={pending !== null} onOpenChange={open => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.kind === "purge" ? `Delete ${quote(pending.item.label)} for good?` : "Empty the trash?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === "purge"
                ? pending.item.kind === "asset" ? "The file is removed from storage." : "The document and its history are removed."
                : `All ${items.length} ${items.length === 1 ? "item" : "items"} are removed, with their history and files.`} This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={confirm}>Delete for good</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** A read-only look at what was deleted: the document's fields per language, or the file itself. */
function TrashPreview({ item, busy, onOpenChange, onRestore, onPurge }: {
  item: TrashItem | null,
  busy: boolean,
  onOpenChange(open: boolean): void,
  onRestore(item: TrashItem): void,
  onPurge(item: TrashItem): void
}) {
  const { cms, config, session } = useAdmin();
  const detail = useQuery({
    queryKey: ["trash-item", item?.id],
    enabled: item !== null,
    queryFn: () => cms.actions.trash.get({ id: item!.id })
  });
  const data = item && detail.data?.id === item.id ? detail.data : undefined;
  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle className="truncate pr-8">{item?.label}</SheetTitle>
          <SheetDescription>
            {item && (item.kind === "asset"
              ? "File"
              : <>
                <strong>{collectionLabel(config, item.type!, false)}</strong>
                <p>deleted <strong>{formatRelative(item.deletedAt)}</strong> by {displayUser(item.deletedBy, session)}</p>
                <p>expires <strong>{formatRelative(item.expiresAt)}</strong></p>
              </>
            )}
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
          {detail.isError ? <p className="text-sm text-destructive">{(detail.error as Error).message}</p>
            : !data ? <Delayed><div className="flex justify-center p-10"><Spinner /></div></Delayed>
              : data.asset ? <TrashedFile asset={data.asset} id={data.id} />
                : <TrashedDocument type={data.type!} id={data.itemId} documents={data.documents ?? []} />}
        </div>
        {item && (
          <SheetFooter className="flex-row justify-end border-t">
            <Button variant="ghost" className="text-destructive" disabled={busy} onClick={() => onPurge(item)}><Trash2Icon /> Delete for good</Button>
            <Button disabled={busy} onClick={() => onRestore(item)}><RotateCcwIcon /> Restore</Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}

function TrashedDocument({ type, id, documents }: { type: string, id: string, documents: NonNullable<TrashDetail["documents"]> }) {
  const { config } = useAdmin();
  const [locale, setLocale] = useState(() => (documents.find(d => d.locale === config.defaultLocale) ?? documents[0])?.locale);
  const shown = documents.find(d => d.locale === locale) ?? documents[0];
  if(!shown) return null;
  const schema = collectionSchema(config, type);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {documents.length > 1 ? (
          <Segmented label="Language" value={shown.locale} onChange={setLocale} options={documents.map(d => ({ value: d.locale, label: localeName(d.locale) }))} />
        ) : <span className="text-sm text-muted-foreground">{localeName(shown.locale)}</span>}
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <StatusDot status={shown.status} />
          {{ draft: "Was a draft", published: "Was published", changed: "Was published, with unpublished changes" }[shown.status]}
        </span>
      </div>
      <FormValueContext.Provider value={shown.data}>
        <div className="pointer-events-none flex flex-col gap-5 opacity-90">
          {Object.entries(schema.shape).map(([key, field]) => (
            <Field key={`${shown.locale}/${key}`} schema={field} name={key} path={[key]} value={shown.data[key]} issues={[]} readOnly doc={{ type, id }} onChange={() => {}} />
          ))}
        </div>
      </FormValueContext.Provider>
    </div>
  );
}

/** Trashed files aren't served publicly, so the bytes come through the API and preview from a blob URL. */
function TrashedFile({ asset, id }: { asset: Asset, id: string }) {
  const { info } = useAdmin();
  const blob = useQuery({
    queryKey: ["trash-file", id],
    queryFn: () => requestBlob(info.prefix, `/trash/${id}/file`),
    staleTime: Infinity
  });
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if(!blob.data) return;
    const next = URL.createObjectURL(blob.data);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob.data]);
  const local = url ? { ...asset, url } : null;
  return (
    <div className="flex flex-col gap-4">
      <div className={cn("overflow-hidden rounded-[10px] well", !assetTextKind(asset) && "bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]")}>
        {blob.isError ? <p className="p-4 text-sm text-destructive">{(blob.error as Error).message}</p>
          : !local ? <div className="flex h-40 items-center justify-center"><Spinner /></div>
            : assetTextKind(asset) ? <TextPreview asset={local} /> : <AssetPreview asset={local} />}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-1 text-sm">
        <dt className="eyebrow">File</dt><dd className="truncate">{describeAsset(asset)}</dd>
        <dt className="eyebrow">Folder</dt><dd className="truncate">{asset.folder ?? "All files"}</dd>
        <dt className="eyebrow">Uploaded</dt><dd>{formatDate(asset.createdAt)}</dd>
      </dl>
    </div>
  );
}

function quote(name: string): string {
  return `“${name.length > 40 ? `${name.slice(0, 39)}…` : name}”`;
}
