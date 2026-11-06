import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, FileTextIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "../components/ui/button.tsx";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../components/ui/empty.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table.tsx";
import { cn } from "../lib/utils.ts";
import { Delayed, useArrival } from "./delayed.tsx";
import { collectionLabel, collectionSettings, documentTitle, formatDate, formatRelative, localeName, titleField, useAdmin } from "./context.tsx";
import { EditorPage } from "./editor.tsx";
import { Marked, markTitle } from "./marked.tsx";
import { Link, navigate, useLocation } from "./router.tsx";
import { StatusBadge, StatusDot, StatusIcon, statusLabel } from "./status.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";

const PAGE = 25;

/** Position in a `.stagger` list (see styles.css). */
export function staggerIndex(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ListPage({ type }: { type: string }) {
  const { cms, config, locale, session, plugins, site } = useAdmin();
  const { search: params } = useLocation();
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const page = Number(params.get("page") ?? 0);
  // A search ranks best matches first until a column is picked for it; clearing the search restores the table's sort.
  const [searchSort, setSearchSort] = useState<string | null>(null);
  useEffect(() => {
    if(!query.trim()) setSearchSort(null);
  }, [query]);
  const sort = query.trim() ? searchSort ?? "" : params.get("sort") ?? "-$updatedAt";
  const settings = collectionSettings(config, type);
  const label = collectionLabel(config, type);
  const titleKey = titleField(config, type);
  const canWrite = session.permissions.types[type]?.write;
  const columns = plugins.slots["list.columns"]!.filter(c => c.type === type);

  const list = useQuery({
    queryKey: ["documents", type, locale, query, page, sort],
    queryFn: () => cms.actions.documents.list({ type, locale, search: query || undefined, limit: PAGE, offset: page * PAGE, sort: sort || undefined }),
    placeholderData: keepPreviousData
  });
  const arrival = useArrival(!list.isLoading);

  useEffect(() => {
    document.title = `${label} · ${site.name}`;
  }, [label, site.name]);

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
    const next = sort === `-${field}` ? field : `-${field}`;
    if(query.trim()) setSearchSort(next);
    else setParam("sort", next);
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
  const all = list.data?.all ?? 0;
  // The search the shown rows answer, which lags typing while the next page loads.
  const matched = list.isPlaceholderData ? "" : query.trim();
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-6 md:px-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <p className="eyebrow" data-shared="eyebrow">Content{config.locales!.length > 1 ? ` · ${localeName(locale)}` : ""}</p>
          <h1 className="text-2xl font-medium tracking-[-0.025em]" data-shared="title">{label}</h1>
          <p className="text-sm text-muted-foreground" data-shared="summary">
            {!list.data ? " " : query.trim()
              ? `${total} of ${all} ${all === 1 ? "document" : "documents"}`
              : `${total} ${total === 1 ? "document" : "documents"}`}
          </p>
        </div>
        <div className="flex items-center gap-2" data-shared="actions">
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
        <Empty className="rounded-[16px] well">
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
        <div className={cn("overflow-hidden rounded-[16px] elevated transition-opacity", arrival, list.isPlaceholderData && "opacity-60")}>
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
                    <Link to={`/content/${type}/${doc.id}`} className="block truncate" onClick={e => e.stopPropagation()}>
                      {matched ? <Marked text={markTitle(documentTitle(config, type, doc), matched)} /> : documentTitle(config, type, doc)}
                    </Link>
                    {matched && list.data!.excerpts[doc.id] && <span className="block truncate text-xs font-normal text-muted-foreground"><Marked text={list.data!.excerpts[doc.id]!} /></span>}
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

/** The newest few documents and the total of each readable type: the dashboard's cards, and the navigation's counts. */
export function useTypeStats(types: string[], enabled = true) {
  const { cms, locale } = useAdmin();
  return useQuery({
    queryKey: ["dashboard", locale],
    enabled,
    queryFn: async () => Promise.all(types.map(async type => {
      const result = await cms.actions.documents.list({ type, locale, limit: 5 });
      return { type, ...result };
    }))
  });
}

/**
 * Column count (3 or 4) that leaves the fewest empty cells on the last row, so
 * a count like 9 is a clean 3×3 instead of 4 + 4 + 1. Ties go to more columns.
 */
function fillColumns(count: number): number {
  function empty(cols: number) {
    return (cols - (count % cols)) % cols;
  }
  return empty(4) <= empty(3) ? 4 : 3;
}

export function Dashboard() {
  const { config, session, site } = useAdmin();
  const types = Object.keys(config.schemas).filter(t => session.permissions.types[t]?.read);
  const stats = useTypeStats(types);
  useEffect(() => {
    document.title = site.name;
  }, [site.name]);
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
        <div className="flex flex-wrap items-end justify-between gap-6 pt-6">
          <div className="space-y-2">
            <p className="eyebrow">{location.host}</p>
            <h1 className="text-3xl font-medium tracking-[-0.03em] md:text-4xl">{site.name}</h1>
            <p className="text-sm text-muted-foreground">
              {greeting}{session.user.name ? `, ${session.user.name.split(" ")[0]}` : ""}.
            </p>
          </div>
          {writable.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {writable.slice(0, 3).map(type => (
                <Button key={type} variant="outline" size="sm" nativeButton={false} render={<Link to={`/content/${type}/new`} />}>
                  <PlusIcon /> {collectionLabel(config, type, false)}
                </Button>
              ))}
            </div>
          )}
        </div>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow">Content</h2>
        <div
          style={{ "--cols": `repeat(${fillColumns(types.length)}, minmax(0, 1fr))` } as CSSProperties}
          className="stagger grid grid-cols-2 gap-3 md:grid-cols-(--cols) max-md:[&>:last-child:nth-child(odd)]:col-span-2"
        >
          {types.map((type, i) => {
            const entry = stats.data?.find(s => s.type === type);
            const settings = collectionSettings(config, type);
            return (
              <Link
                key={type}
                to={`/content/${type}`}
                style={staggerIndex(i)}
                className="group/card relative flex flex-col gap-6 rounded-[16px] elevated p-5 transition-[box-shadow,scale,translate] duration-200 ease-out hover:-translate-y-px hover:shadow-(--shadow-raised-hover) active:translate-y-0 active:scale-[0.98]"
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
        <div className="stagger flex flex-col gap-0.5 rounded-[16px] elevated p-1">
          {stats.isLoading ? <Delayed><div className="p-6"><Spinner /></div></Delayed>
            : recent.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Nothing yet. Pick a content type to start writing.</p>
              : recent.map(({ type, doc }, i) => (
                <Link
                  key={doc.id}
                  to={`/content/${type}/${doc.id}`}
                  style={staggerIndex(i)}
                  className="group/row flex items-center gap-3 rounded-[12px] px-3 py-2.5 text-sm transition-[background-color,scale] duration-150 hover:bg-foreground/[0.04] active:scale-[0.99]"
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

export function UsageLink({ type, id, locale }: { type: string, id: string, locale: string }) {
  const { cms, config } = useAdmin();
  const doc = useQuery({
    queryKey: ["document", type, id, locale],
    queryFn: () => cms.actions.documents.get({ type, id, locale })
  });
  const title = doc.data ? documentTitle(config, type, doc.data.draft) : "…";
  const where = `${collectionLabel(config, type, false)}${config.locales!.length > 1 ? ` · ${localeName(locale)}` : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Link to={`/content/${type}/${id}?locale=${locale}`} className="flex min-w-0 items-center gap-2 rounded-[8px] px-1.5 py-1 hover:bg-foreground/[0.05]">
          <StatusIcon status={doc.data?.status} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{collectionLabel(config, type, false)}{config.locales!.length > 1 ? ` · ${locale}` : ""}</span>
          </span>
        </Link>
      } />
      {/* The full title, which the row cuts off, with where it lives and its status. */}
      <TooltipContent side="left" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium">{title}</p>
          <p className="opacity-70">{where}</p>
          {doc.data && (
            <p className="flex items-center gap-1.5 opacity-70">
              <StatusIcon status={doc.data.status} className="size-3" />
              {statusLabel(doc.data.status)}
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

export { StatusBadge };
