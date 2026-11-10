import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeftIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { diff, withPositionalKeys, type CheckedChange } from "../../changes/index.ts";
import type { DocumentData } from "../../schema/types.ts";
import { Button } from "../components/ui/button.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { cn } from "../lib/utils.ts";
import { ActivityList } from "./activity.tsx";
import { askConfirm } from "./confirm.tsx";
import { collectionSchema, displayUser, documentTitle, formatDate, formatRelative, useAdmin } from "./context.tsx";
import { Delayed } from "./delayed.tsx";
import { Field } from "./fields.tsx";
import { ChangeView, FieldName } from "./publish.tsx";
import { Link, navigate, useLocation } from "./router.tsx";
import { Segmented } from "./segmented.tsx";
import { staggerIndex } from "./pages.tsx";

type Tab = "versions" | "activity";

/**
 * A document's history: every published version (`/content/:type/:id/history`), each shown as what it
 * changed from the one before (or in full), with Restore; and its activity (`/content/:type/:id/activity`).
 * The two are sibling pages, so switching between them plays the app's page transition while the header,
 * shared by both, holds still.
 */
export function HistoryPage({ type, id, tab }: { type: string, id: string, tab: Tab }) {
  const { cms, config, locale, session } = useAdmin();
  const { search } = useLocation();
  const editorPath = `/content/${type}/${id}${locale === config.defaultLocale ? "" : `?locale=${encodeURIComponent(locale)}`}`;
  const doc = useQuery({ queryKey: ["document", type, id, locale], queryFn: () => cms.actions.documents.get({ type, id, locale }), retry: false });
  const title = documentTitle(config, type, doc.data?.draft ?? doc.data?.published);
  const permissions = session.permissions.types[type];
  const canRestore = Boolean(permissions?.write && session.permissions.locales.includes(locale));

  useEffect(() => {
    document.title = `History · ${title}`;
  }, [title]);

  function setTab(next: Tab) {
    const query = search.toString();
    navigate(`/content/${type}/${id}/${next === "versions" ? "history" : "activity"}${query ? `?${query}` : ""}`, { replace: true });
  }

  return (
    <div className="flex min-h-full flex-col">
      {/* The same bar on both tabs (`data-shared`), so it stays put while only the content changes over. */}
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur-md md:px-6" data-shared="bar">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Button variant="ghost" size="icon-sm" className="-ml-1.5 rounded-[8px] md:-ml-3.5" aria-label="Back to the editor" nativeButton={false} render={<Link to={editorPath} />}>
            <ChevronLeftIcon />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-[15px] font-semibold">{title}</h1>
            <p className="truncate text-xs text-muted-foreground">History</p>
          </div>
        </div>
        <div>
          <Segmented<Tab> label="History" value={tab} onChange={setTab} options={[{ value: "versions", label: "Versions" }, { value: "activity", label: "Activity" }]} />
        </div>
      </header>
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 md:px-8">
        {tab === "activity"
          ? <ActivityList filter={{ targetId: id }} />
          : <Versions type={type} id={id} liveVer={doc.data?.publishedVer ?? null} canRestore={canRestore} editorPath={editorPath} />}
      </div>
    </div>
  );
}

function Versions({ type, id, liveVer, canRestore, editorPath }: { type: string, id: string, liveVer: number | null, canRestore: boolean, editorPath: string }) {
  const { cms, config, locale, session } = useAdmin();
  const queryClient = useQueryClient();
  const versions = useQuery({ queryKey: ["versions", type, id, locale], queryFn: () => cms.actions.documents.versions({ type, id, locale }) });
  const list = versions.data?.versions ?? [];
  const [picked, setPicked] = useState<number | null>(null);
  // The live version first, else the newest.
  const selected = picked ?? liveVer ?? list[0]?.ver ?? null;
  const index = list.findIndex(v => v.ver === selected);
  const previous = index >= 0 ? list[index + 1]?.ver ?? null : null;
  const [whole, setWhole] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const schema = collectionSchema(config, type);

  // Picking another version keeps the one on screen until the next arrives: versions look alike, so a
  // loading flash or a replayed entrance would read as a flicker.
  const current = useQuery({
    queryKey: ["version", type, id, locale, selected],
    enabled: selected !== null,
    placeholderData: keepPreviousData,
    queryFn: () => cms.actions.documents.version({ type, id, locale, ver: selected! })
  });
  const before = useQuery({
    queryKey: ["version", type, id, locale, previous],
    enabled: previous !== null,
    placeholderData: keepPreviousData,
    queryFn: () => cms.actions.documents.version({ type, id, locale, ver: previous! })
  });
  // Worked out only once both versions of this pair have arrived; until then the last pair stays on
  // screen, heading and all, rather than comparing the new version with the old one's neighbour.
  const ready = Boolean(current.data && !current.isPlaceholderData && (previous === null || (before.data && !before.isPlaceholderData)));
  const computed = useMemo(() => {
    if(!ready) return null;
    const a = previous === null ? {} : withPositionalKeys(schema, structuredClone(before.data!.data as DocumentData));
    const b = withPositionalKeys(schema, structuredClone(current.data!.data as DocumentData));
    return {
      ver: selected,
      previous,
      data: current.data!,
      changes: diff(schema, a, b).map(change => ({ ...change, status: "clean" }) as CheckedChange)
    };
  }, [ready, current.data, before.data, previous, schema, selected]);
  const [last, setLast] = useState<typeof computed>(null);
  useEffect(() => {
    if(computed) setLast(computed);
  }, [computed]);
  const view = computed ?? last;
  const changes = view?.changes ?? [];
  // The changes cascade in once, when the page first shows a version; later picks swap in place.
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if(view && !shown) {
      const timer = setTimeout(() => setShown(true), 600);
      return () => clearTimeout(timer);
    }
  }, [view, shown]);

  async function restore() {
    if(selected === null) return;
    const ok = await askConfirm({
      title: `Restore version ${selected}?`,
      description: "It's copied into your unpublished changes, replacing what you have there. Nothing goes live until you publish.",
      action: "Restore"
    });
    if(!ok) return;
    setRestoring(true);
    try {
      const result = await cms.actions.documents.restoreVersion({ type, id, locale, ver: selected });
      queryClient.setQueryData(["document", type, id, locale], result);
      cms.toast(`Version ${selected} copied into your changes`, { type: "success" });
      navigate(editorPath);
    } catch (error) {
      cms.toast(error instanceof Error ? error.message : "Couldn't restore", { type: "error" });
    } finally {
      setRestoring(false);
    }
  }

  if(versions.isPending) return <Delayed><Skeleton className="h-48 w-full" /></Delayed>;
  if(!list.length) return <p className="rise-in rounded-[14px] p-8 text-center text-sm text-muted-foreground well">Not published yet. Each publish is kept here.</p>;

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="lg:sticky lg:top-20">
        {/* Padded inside its scroll box, so the selected version's raised shadow isn't cut off. */}
        <ul className="stagger -m-1.5 flex flex-col gap-0.5 p-1.5 max-lg:max-h-64 max-lg:overflow-y-auto lg:max-h-[calc(100dvh-10.5rem)] lg:overflow-y-auto">
          {list.map((v, i) => (
            <li key={v.ver} style={staggerIndex(i)}>
              <button type="button" onClick={() => setPicked(v.ver)} aria-current={selected === v.ver || undefined}
                className={cn("flex w-full flex-col rounded-[10px] px-3 py-2 text-left text-sm transition-colors hover:bg-foreground/[0.04]", selected === v.ver && "raised")}>
                <span className="flex items-center gap-2 font-medium">
                  Version {v.ver}
                  {liveVer === v.ver && <span className="rounded-full bg-emerald-500/12 px-1.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">Live</span>}
                </span>
                <span className="text-xs text-muted-foreground" title={formatDate(v.createdAt)}>{formatRelative(v.createdAt)} · {displayUser(v.author, session)}</span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Version {view?.ver ?? selected}{liveVer === (view?.ver ?? selected) ? " · live" : ""}</h2>
            <p className="text-sm text-muted-foreground">
              {view ? `Published ${formatDate(view.data.createdAt)} by ${displayUser(view.data.author, session)}` : " "}
            </p>
          </div>
          <Segmented<"changes" | "whole"> label="Show" value={whole ? "whole" : "changes"} onChange={value => setWhole(value === "whole")}
            options={[{ value: "changes", label: (view?.previous ?? previous) === null ? "What it set" : `Changes from ${view?.previous ?? previous}` }, { value: "whole", label: "Whole version" }]} />
          {canRestore && (
            <Button variant="outline" size="sm" disabled={restoring || !current.data} onClick={() => void restore()}>
              {restoring ? <Spinner /> : <RotateCcwIcon />} Restore
            </Button>
          )}
        </div>

        {/* Changes and the whole version are different views: switching between them arrives like new content. */}
        {!view ? <Delayed><Skeleton className="h-40 w-full" /></Delayed> : <div key={whole ? "whole" : "changes"} className={cn(shown && "rise-in")}>{
          whole ? (
            <div className="pointer-events-none flex flex-col gap-6 rounded-[16px] p-5 elevated">
              {Object.entries(schema.shape).map(([key, field]) => (
                <Field key={key} schema={field} name={key} path={[key]} value={(view.data.data as DocumentData)[key]} issues={[]} readOnly doc={{ type, id }} onChange={() => {}} />
              ))}
            </div>
          ) : !changes.length ? (
            <p className="rounded-[14px] p-6 text-center text-sm text-muted-foreground well">Published with no changes from version {view.previous}.</p>
          ) : (
            <ul className={cn("flex flex-col divide-y overflow-hidden rounded-[16px] well", !shown && "stagger")}>
              {changes.map((change, i) => (
                <li key={change.path} style={staggerIndex(i)} className="flex flex-col gap-1.5 px-4 py-3">
                  <FieldName change={change} />
                  <ChangeView change={change} />
                </li>
              ))}
            </ul>
          )}</div>}
      </section>
    </div>
  );
}
