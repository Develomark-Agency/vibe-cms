import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CalendarClockIcon,
  CheckIcon,
  ChevronLeftIcon,
  CircleCheckIcon,
  ClockIcon,
  CloudUploadIcon,
  Trash2Icon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileIcon,
  FileTextIcon,
  FileVideoIcon,
  PencilLineIcon,
  PlayIcon,
  TriangleAlertIcon,
  Undo2Icon
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAt, type CheckedChange } from "../../changes/index.ts";
import { isLongText, plainText, textDiff, trimDiff } from "../../changes/text.ts";
import type { BranchChanges, DocumentState } from "../../handler/engine.ts";
import type { Via } from "../../handler/activity.ts";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { cn } from "../lib/utils.ts";
import { isActionError } from "../../actions/errors.ts";
import { VIA_LABELS } from "./via.ts";
import { collectionSchema, displayUser, documentTitle, formatDate, formatRelative, useAdmin } from "./context.tsx";
import { describeAsset, useAsset } from "./pickers.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { Link, navigate } from "./router.tsx";
import { PersonFace, PersonFaces, type FacePerson } from "./person.tsx";
import { askConfirm } from "./confirm.tsx";
import { useArrival } from "./delayed.tsx";
import { staggerIndex } from "./pages.tsx";

/** One person's change, as publishing names it: `owner` + `change.path`. */
interface Entry {
  owner: string,
  change: CheckedChange
}

/**
 * One line of the review: a field, whoever changed it. A clean row is ticked or not; a choice row (two
 * people disagree, or live moved on) is settled by picking one side.
 */
interface Row {
  id: string,
  kind: "clean" | "choice",
  status: "clean" | "conflict" | "stale",
  entries: Entry[],
  /** The outermost change, which names the row and holds its value. */
  outer: CheckedChange,
  /** The conflict's group, for `resolve`. */
  group?: string,
  live: unknown
}

/** Undecided rows aren't in the map; they stay unpublished, like "later", but still ask. */
type Choice = { use: string } | { value: string } | "later";

/** How many sides of a conflict show before "N more". */
const SHOWN_OPTIONS = 4;
/** Rows past which the review offers to show only what needs a choice. */
const MANY_ROWS = 6;

function sameChoice(a: Choice | undefined, b: Choice): boolean {
  if(a === undefined) return false;
  if(typeof a === "object" && typeof b === "object" && "value" in a && "value" in b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The review before publishing, a page of its own (`/content/:type/:id/review`): every change, field by
 * field, whoever made it. Clean changes are ticked; a field two people changed (or that was published
 * differently since) asks for a choice, and says so once it's settled. With nothing to settle, Review
 * then Publish is two clicks. People who can't publish see the same page, without the choices.
 */
export function ReviewPage({ type, id }: { type: string, id: string }) {
  const { cms, config, locale, session } = useAdmin();
  const queryClient = useQueryClient();
  const open = true;
  const permissions = session.permissions.types[type];
  const canPublish = Boolean(permissions?.publish && session.permissions.locales.includes(locale));
  const doc = useQuery({ queryKey: ["document", type, id, locale], queryFn: () => cms.actions.documents.get({ type, id, locale }), retry: false });
  const title = documentTitle(config, type, doc.data?.draft ?? doc.data?.published);
  const editorPath = `/content/${type}/${id}${location.search}`;

  useEffect(() => {
    document.title = `Review ${title}`;
  }, [title]);

  /** What publishing or discarding returns is the document as the editor shows it now. */
  function onDone(result: DocumentState) {
    queryClient.setQueryData(["document", type, id, locale], result);
    void queryClient.invalidateQueries({ queryKey: ["documents", type] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }
  function onOpenChange(next: boolean) {
    if(!next) navigate(editorPath);
  }
  const changes = useQuery({
    queryKey: ["changes", type, id, locale],
    enabled: open,
    queryFn: () => cms.actions.documents.changes({ type, id, locale }),
    staleTime: 0,
    // A refetch mid-choice would move things under the cursor; it refetches on opening, and after a failed publish.
    refetchOnWindowFocus: false
  });
  const [unticked, setUnticked] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Map<string, Choice>>(new Map());
  const [reopened, setReopened] = useState<Set<string>>(new Set());
  const [onlyChoices, setOnlyChoices] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState<string | null>(null);
  const publishButton = useRef<HTMLButtonElement>(null);
  const schedulePanel = useRef<HTMLDivElement>(null);
  const isScheduling = scheduling !== null;
  // On a phone the sidebar is under the changes: bring the schedule into view when it opens.
  useEffect(() => {
    if(isScheduling) schedulePanel.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [isScheduling]);

  function reset() {
    setUnticked(new Set());
    setChoices(new Map());
    setReopened(new Set());
  }

  useEffect(() => {
    if(!open) return;
    reset();
    setError(null);
    setScheduling(null);
    setOnlyChoices(false);
  }, [open]);

  // The second click: once the changes are in, Enter publishes them.
  useEffect(() => {
    if(open && changes.data) requestAnimationFrame(() => publishButton.current?.focus());
  }, [open, changes.data]);

  const branches = changes.data?.branches ?? [];
  const names = new Map(branches.map(b => [b.owner, b.owner === session.user.sub ? "You" : b.name ?? displayUser(b.owner, session)]));
  function nameOf(owner: string) {
    return names.get(owner) ?? displayUser(owner, session);
  }
  /** Who a face shows. You get your own marker, which reads as "you" better than any initials. */
  function faceOf(owner: string): FacePerson {
    return { id: owner, name: nameOf(owner), self: owner === session.user.sub };
  }
  const schema = collectionSchema(config, type);
  const rows = useMemo(() => rowsOf(changes.data?.live ?? null, branches, Object.keys(schema.shape)), [changes.data, schema]);

  function included(row: Row): boolean {
    if(row.kind === "clean") return !unticked.has(row.id);
    const choice = choices.get(row.id);
    return choice !== undefined && choice !== "later";
  }

  const chosen = rows.filter(included);
  const owners = [...new Set(chosen.flatMap(row => row.entries.map(e => e.owner)))];
  const undecided = rows.filter(row => row.kind === "choice" && !choices.has(row.id)).length;
  const counted = chosen.length === 1 ? "1 change" : `${chosen.length} changes`;
  const missingValue = [...choices.values()].some(choice => typeof choice === "object" && "value" in choice && choice.value === "");
  const reason = chosen.length === 0 ? "Nothing selected" : missingValue ? "Type the value to publish" : null;

  /** What's ticked and chosen, as `documents.publish` and `documents.schedule` take it. */
  function selection() {
    const rowOf = new Map(rows.flatMap(row => row.entries.map(e => [`${e.owner}\u0000${e.change.path}`, row] as const)));
    const skip = branches.filter(b => owners.includes(b.owner)).flatMap(b => b.changes
      .filter(c => {
        const row = rowOf.get(`${b.owner}\u0000${c.path}`);
        return !row || !included(row);
      })
      .map(c => ({ owner: b.owner, path: c.path })));
    const resolve = chosen.filter(row => row.kind === "choice").map(row => ({ group: row.group!, ...(choices.get(row.id) as Exclude<Choice, "later">) }));
    return { branches: owners, skip, resolve };
  }

  async function publish(runAt?: string) {
    setBusy(true);
    setError(null);
    try {
      const result = runAt
        ? await cms.actions.documents.schedule({ type, id, locale, action: "publish", runAt, ...selection() })
        : await cms.actions.documents.publish({ type, id, locale, ...selection() });
      onDone(result);
      void queryClient.invalidateQueries({ queryKey: ["changes", type, id, locale] });
      cms.toast(runAt ? `Scheduled ${counted} for ${formatDate(runAt)}` : `Published ${counted}`, { type: "success" });
      onOpenChange(false);
    } catch (failure) {
      // Someone saved or published meanwhile: show the changes as they are now.
      if(isActionError(failure) && failure.code === "CONFLICT") void changes.refetch().then(reset);
      setError(failure instanceof Error ? failure.message : "Couldn't publish");
    } finally {
      setBusy(false);
    }
  }

  async function discard(owner: string) {
    try {
      onDone(await cms.actions.documents.discardChanges({ type, id, locale, owner }));
      cms.toast(owner === session.user.sub ? "Discarded your changes" : `Discarded ${nameOf(owner)}'s changes`, { type: "success" });
      await changes.refetch();
      reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't discard");
    }
  }

  function choose(row: Row, choice: Choice) {
    setChoices(prev => new Map(prev).set(row.id, choice));
    // Typing a value keeps the choices open; anything else settles the row.
    if(!(typeof choice === "object" && "value" in choice)) {
      setReopened(prev => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  }

  const clean = rows.filter(row => row.kind === "clean");
  const allClean = clean.length > 0 && clean.every(row => !unticked.has(row.id));
  const shown = onlyChoices ? rows.filter(row => row.kind === "choice") : rows;
  const conflicts = rows.length - clean.length;

  const arrival = useArrival(!changes.isPending);
  function discardFor(owner: string) {
    return canPublish || owner === session.user.sub ? () => discard(owner) : undefined;
  }
  const status = error ?? reason ?? (undecided > 0 ? `${undecided} skipped` : null);

  return (
    <div className="flex min-h-full flex-col">
      {/* The editor's header, with this page's actions where the editor has Save and Review. */}
      <header className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b bg-background/95 px-4 py-2.5 backdrop-blur-md md:px-6">
        <Button variant="ghost" size="icon-sm" className="-ml-1.5 rounded-[8px] md:-ml-3.5" aria-label="Back to the editor" nativeButton={false} render={<Link to={editorPath} />}>
          <ChevronLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[15px] font-semibold">{title}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {changes.isPending ? "Checking what's changed…" : !rows.length ? "No unpublished changes" : canPublish ? `Review · ${chosen.length} of ${rows.length} selected` : `Review · ${rows.length} unpublished`}
          </p>
        </div>
        {canPublish && (
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" disabled={busy || reason !== null} aria-label="Schedule"
              onClick={() => setScheduling(scheduling === null ? toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)) : null)}>
              <CalendarClockIcon /> <span className="max-sm:hidden">Schedule…</span>
            </Button>
            <Button ref={publishButton} size="sm" disabled={busy || reason !== null} onClick={() => void publish()}>
              {busy && scheduling === null ? <Spinner /> : <CloudUploadIcon />} Publish{chosen.length ? <> {chosen.length}<span className="max-sm:hidden"> {chosen.length === 1 ? "change" : "changes"}</span></> : ""}
            </Button>
          </div>
        )}
      </header>

      <div className="mx-auto grid w-full max-w-6xl flex-1 items-start gap-8 px-4 py-6 md:px-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <main className="flex min-w-0 flex-col gap-3">
          {canPublish && rows.length > 0 && (clean.length > 1 || rows.length > MANY_ROWS) && (
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              {clean.length > 1 && (
                <label className="flex items-center gap-2">
                  <Checkbox checked={allClean} indeterminate={!allClean && clean.some(row => !unticked.has(row.id))}
                    onCheckedChange={checked => setUnticked(checked ? new Set() : new Set(clean.map(row => row.id)))} />
                  Select all
                </label>
              )}
              {conflicts > 0 && rows.length > MANY_ROWS && (
                <button type="button" className={cn("ml-auto rounded-full px-2 py-0.5 text-xs", onlyChoices ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : "hover:text-foreground")}
                  aria-pressed={onlyChoices} onClick={() => setOnlyChoices(!onlyChoices)}>
                  {onlyChoices ? `Showing ${conflicts} to decide` : `Only show ${conflicts} to decide`}
                </button>
              )}
            </div>
          )}
          {changes.isPending && <Skeleton className="h-40 w-full" />}
          {!changes.isPending && !rows.length && (
            <p className="rounded-[14px] p-6 text-center text-sm text-muted-foreground well">Everything on this document is published.</p>
          )}
          {shown.length > 0 && (
            <ul className="stagger flex flex-col divide-y overflow-hidden rounded-[16px] well">
              {shown.map((row, i) => (
                <ReviewRow
                  key={row.id}
                  index={i}
                  row={row}
                  nameOf={nameOf}
                  faceOf={faceOf}
                  readOnly={!canPublish}
                  ticked={!unticked.has(row.id)}
                  onTick={on => setUnticked(prev => {
                    const next = new Set(prev);
                    if(on) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  })}
                  choice={choices.get(row.id)}
                  open={!choices.has(row.id) || reopened.has(row.id) || (typeof choices.get(row.id) === "object" && "value" in (choices.get(row.id) as object))}
                  onChoose={choice => choose(row, choice)}
                  onReopen={() => setReopened(prev => new Set(prev).add(row.id))}
                />
              ))}
            </ul>
          )}
        </main>

        {/* Like the editor's sidebar: what's going on, and who. Under the changes on a phone, which come first. */}
        {/* Pinned while the changes scroll, and never taller than the window under the app bar and this header (10.5rem): the people list scrolls instead. */}
        <aside className={cn("flex flex-col gap-4 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-10.5rem)]", arrival)}>
          {(status || scheduling !== null) && canPublish && (
            <section className={cn("flex flex-col gap-3 rounded-[16px] p-4 elevated", error && "shadow-[inset_0_0_0_1px] shadow-destructive/30")}>
              {status && <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{status}</p>}
              {scheduling !== null && (
                <div className="flex flex-col gap-2" ref={schedulePanel}>
                  <h3 className="flex items-center gap-1.5 text-sm font-medium text-violet-700 dark:text-violet-300"><CalendarClockIcon className="size-3.5" /> Schedule</h3>
                  <Input type="datetime-local" value={scheduling} onChange={e => setScheduling(e.target.value)} aria-label="When to publish" />
                  <p className="text-xs text-muted-foreground">What's selected now is captured; later saves aren't included.</p>
                  <div className="flex gap-1.5">
                    <Button size="sm" disabled={busy || reason !== null || !scheduling} onClick={() => void publish(new Date(scheduling).toISOString())}>
                      {busy ? <Spinner /> : <CalendarClockIcon />} Schedule{chosen.length ? ` ${counted}` : ""}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setScheduling(null)}>Cancel</Button>
                  </div>
                </div>
              )}
            </section>
          )}
          {branches.length > 0 && (
            <section className="flex min-h-0 flex-col gap-2 rounded-[16px] p-4 elevated">
              <h3 className="shrink-0 text-sm font-medium">{branches.length === 1 ? "1 person" : `${branches.length} people`}</h3>
              <ul className="-mx-1.5 flex min-h-0 flex-col gap-1 overflow-y-auto px-1.5 max-lg:max-h-96">
                {branches.map(branch => (
                  <PersonRow key={branch.owner} branch={branch} name={nameOf(branch.owner)} face={faceOf(branch.owner)} onDiscard={discardFor(branch.owner)} />
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

/** Every change, one row per field (per conflict for clashes), in the order the document lists its fields. */
function rowsOf(live: unknown, branches: BranchChanges[], fieldOrder: string[]): Row[] {
  const rows = new Map<string, Row>();
  for(const branch of branches) {
    for(const change of branch.changes) {
      const choice = change.status === "conflict" || change.status === "stale";
      const id = choice ? `group:${change.group ?? change.path}` : `path:${change.path}`;
      const row = rows.get(id) ?? { id, kind: choice ? "choice" : "clean", status: choice ? change.status as "conflict" | "stale" : "clean", entries: [], outer: change, group: choice ? change.group ?? change.path : undefined, live: undefined };
      if(change.status === "conflict") row.status = "conflict";
      row.entries.push({ owner: branch.owner, change });
      if(change.segments.length < row.outer.segments.length) row.outer = change;
      row.live = getAt(live, row.outer.segments);
      rows.set(id, row);
    }
  }
  function order(row: Row) {
    const index = fieldOrder.indexOf(String(row.outer.segments[0]));
    return index < 0 ? fieldOrder.length : index;
  }
  return [...rows.values()].sort((a, b) => order(a) - order(b) || a.outer.path.localeCompare(b.outer.path));
}

function toLocalInput(date: Date): string {
  function pad(n: number) {
    return String(n).padStart(2, "0");
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Someone whose changes are in the review: who, where from and when, and a way to discard what they changed. */
function PersonRow({ branch, name, face, onDiscard }: { branch: BranchChanges, name: string, face: FacePerson, onDiscard?: () => Promise<void> }) {
  const via = branch.via !== "ui" ? `${VIA_LABELS[branch.via as Via] ?? branch.via} · ` : "";
  return (
    <li className="group/person -mx-1.5 flex items-center gap-2.5 rounded-[10px] px-1.5 py-1 hover:bg-foreground/[0.04]">
      <PersonFace {...face} className="ring-0" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{name}</span>
        <span className="truncate text-xs text-muted-foreground" title={formatDate(branch.updatedAt)}>{via}{formatRelative(branch.updatedAt)}</span>
      </span>
      {onDiscard && (
        <Tooltip>
          <TooltipTrigger render={
            <Button variant="ghost" size="icon-xs" aria-label={`Discard ${name === "You" ? "your" : `${name}'s`} changes`}
              className="text-muted-foreground opacity-60 group-hover/person:opacity-100 focus-visible:opacity-100"
              onClick={async () => {
                const ok = await askConfirm({
                  title: name === "You" ? "Discard your changes?" : `Discard ${name}'s changes?`,
                  description: "These unpublished changes to the document are thrown away. This can't be undone.",
                  action: "Discard",
                  destructive: true
                });
                if(ok) await onDiscard();
              }}>
              <Trash2Icon />
            </Button>
          } />
          <TooltipContent>Discard {name === "You" ? "your" : "their"} changes</TooltipContent>
        </Tooltip>
      )}
    </li>
  );
}

function ReviewRow({ row, index, nameOf, faceOf, readOnly, ticked, onTick, choice, open, onChoose, onReopen }: {
  row: Row,
  /** Its place in the list, for the arriving cascade. */
  index: number,
  nameOf(owner: string): string,
  faceOf(owner: string): FacePerson,
  readOnly: boolean,
  ticked: boolean,
  onTick(on: boolean): void,
  choice: Choice | undefined,
  open: boolean,
  onChoose(choice: Choice): void,
  onReopen(): void
}) {
  const people = [...new Set(row.entries.map(e => e.owner))].map(faceOf);
  const settled = row.kind === "choice" && choice !== undefined && !open;
  const kind = settled ? choiceKind(choice!) : null;
  // Unsettled clashes are amber; a settled one takes the color of its answer, as its button had.
  const tone = row.kind === "clean" ? "" : !settled ? "bg-amber-500/[0.07]" : { person: "bg-emerald-500/[0.06]", live: "bg-sky-500/[0.06]", own: "bg-violet-500/[0.06]", later: "" }[kind!];
  return (
    <li style={staggerIndex(index)} className={cn("flex items-start gap-3 px-3 py-2.5 transition-colors", tone)}>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">
        {row.kind === "clean"
          ? !readOnly && <Checkbox checked={ticked} onCheckedChange={checked => onTick(Boolean(checked))} aria-label={`Publish ${row.outer.label.join(" ")}`} />
          : !settled ? <TriangleAlertIcon className="size-4 text-amber-600 dark:text-amber-400" aria-label="Needs a choice" />
            : kind === "later" ? <ClockIcon className="size-4 text-muted-foreground" aria-label="Skipped" />
              : kind === "live" ? <Undo2Icon className="size-4 text-sky-600 dark:text-sky-400" aria-label="Keeping live" />
                : <CircleCheckIcon className={cn("size-4", kind === "own" ? "text-violet-600 dark:text-violet-400" : "text-emerald-600 dark:text-emerald-400")} aria-label="Settled" />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-h-5 items-center gap-2">
          <FieldName change={row.outer} />
          {row.kind === "choice" && !settled && (
            <span className="text-xs text-amber-700 dark:text-amber-400">{row.status === "conflict" ? `${optionsOf(row).length} versions` : "Live has changed"}</span>
          )}
          {settled && <Settled choice={choice!} nameOf={nameOf} with={typeof choice === "object" && "use" in choice ? optionsOf(row).find(o => o.owners.includes(choice.use))?.owners.length ?? 1 : 1} />}
          <PersonFaces people={people} className="ml-auto" />
        </div>
        {row.kind === "clean" ? (
          <ChangeView change={row.entries[0]!.change} />
        ) : settled ? (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1"><Outcome row={row} choice={choice!} /></div>
            {!readOnly && <Button variant="ghost" size="xs" className="-my-0.5 text-muted-foreground" onClick={onReopen}>Change</Button>}
          </div>
        ) : (
          <Choices row={row} nameOf={nameOf} faceOf={faceOf} choice={choice} onChoose={onChoose} readOnly={readOnly} />
        )}
      </div>
    </li>
  );
}

/** "Heading", with where it is ("Blocks › Hero ›") quieter in front. */
export function FieldName({ change }: { change: CheckedChange }) {
  const label = change.label.length ? change.label : ["Document"];
  return (
    <span className="min-w-0 truncate text-sm">
      {label.length > 1 && <span className="text-muted-foreground">{label.slice(0, -1).join(" › ")} › </span>}
      <span className="font-medium">{label.at(-1)}</span>
    </span>
  );
}

function choiceKind(choice: Choice): "person" | "live" | "own" | "later" {
  if(choice === "later") return "later";
  if("value" in choice) return "own";
  return choice.use === "live" ? "live" : "person";
}

/** What a settled row went with. `with` counts the people who made that version. */
function Settled({ choice, nameOf, with: together }: { choice: Choice, nameOf(owner: string): string, with: number }) {
  const first = typeof choice === "object" && "use" in choice ? nameOf(choice.use).split(/\s+/)[0]! : "";
  const text = choice === "later" ? "Skipped"
    : "value" in choice ? "Your own value"
      : choice.use === "live" ? "Keeping live"
        : together > 1 ? `Using ${first === "You" ? "yours" : first} and ${together - 1} ${together === 2 ? "other's" : "others'"}`
          : first === "You" ? "Using yours" : `Using ${first}'s`;
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 text-[11px] font-medium", {
      person: "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400",
      live: "bg-sky-500/12 text-sky-700 dark:text-sky-300",
      own: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
      later: "bg-foreground/[0.06] text-muted-foreground"
    }[choiceKind(choice)])}>
      {text}
    </span>
  );
}

/** What a settled row will publish. */
function Outcome({ row, choice }: { row: Row, choice: Choice }) {
  if(choice === "later") return <span className="text-sm text-muted-foreground">Stays unpublished.</span>;
  if("value" in choice) return <span className="text-sm"><Value change={row.outer} value={choice.value} /></span>;
  if(choice.use === "live") return <span className="text-sm text-muted-foreground">{row.live === undefined ? "Stays as it is." : <Value change={row.outer} value={row.live} />}</span>;
  const entry = row.entries.find(e => e.owner === choice.use && e.change.path === row.outer.path) ?? row.entries.find(e => e.owner === choice.use);
  return entry ? <ChangeView change={entry.change} live={row.live} /> : null;
}

/** The sides of a choice row: one per distinct version, with whoever made it. */
function optionsOf(row: Row): Array<{ owners: string[], entries: Entry[] }> {
  const byOwner = new Map<string, Entry[]>();
  for(const entry of row.entries) byOwner.set(entry.owner, [...(byOwner.get(entry.owner) ?? []), entry]);
  const out = new Map<string, { owners: string[], entries: Entry[] }>();
  for(const [owner, entries] of byOwner) {
    const key = JSON.stringify(entries.map(e => [e.change.path, e.change.kind, e.change.after]));
    const option = out.get(key) ?? { owners: [], entries };
    option.owners.push(owner);
    out.set(key, option);
  }
  // The version most people landed on first.
  return [...out.values()].sort((a, b) => b.owners.length - a.owners.length);
}

function Choices({ row, nameOf, faceOf, choice, onChoose, readOnly }: {
  row: Row,
  nameOf(owner: string): string,
  faceOf(owner: string): FacePerson,
  choice: Choice | undefined,
  onChoose(choice: Choice): void,
  readOnly: boolean
}) {
  const [all, setAll] = useState(false);
  const options = optionsOf(row);
  const outer = row.outer;
  const values = options.map(o => o.entries.find(e => e.change.path === outer.path)?.change.after);
  const typable = !readOnly && outer.kind === "set" && outer.detail === "value" && outer.field === "text" && !isLongText(row.live, ...values);
  const visible = all ? options : options.slice(0, SHOWN_OPTIONS);
  const typing = typeof choice === "object" && "value" in choice;

  function who(owners: string[]) {
    // Full names: first names alone can't tell two Bobs apart. Hovering the faces lists everyone.
    const names = owners.map(o => nameOf(o)).map((n, i) => (i && n === "You" ? "you" : n));
    const said = names.length <= 2 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names.length - 2} others`;
    return said.charAt(0).toUpperCase() + said.slice(1);
  }

  return (
    <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={`Which ${outer.label.join(" ")} to publish`}>
      {/* What's live comes first: the version nobody has to change anything for. */}
      <ChoiceCard tone="live" checked={sameChoice(choice, { use: "live" })} disabled={readOnly} onSelect={() => onChoose({ use: "live" })}
        head={<><Undo2Icon className="size-3.5" /> {row.status === "stale" ? "Live (updated since)" : "Live"}</>}>
        {row.live === undefined ? <Quiet>Not set</Quiet> : <OptionValue change={{ ...outer, kind: "set", after: row.live }} live={row.live} />}
      </ChoiceCard>
      {visible.map(option => (
        <ChoiceCard key={option.owners[0]} tone="person" checked={sameChoice(choice, { use: option.owners[0]! })} disabled={readOnly}
          onSelect={() => onChoose({ use: option.owners[0]! })}
          head={<><PersonFaces people={option.owners.map(faceOf)} max={5} />{option.owners.length > 1 && <span>{option.owners.length === 2 ? "Both" : `All ${option.owners.length}`} made this edit</span>}<span className="sr-only">{who(option.owners)}</span></>}>
          {option.entries.map(entry => <OptionValue key={entry.change.path} change={entry.change} live={row.live} />)}
        </ChoiceCard>
      ))}
      {options.length > SHOWN_OPTIONS && (
        <button type="button" className="w-fit text-xs text-muted-foreground underline underline-offset-3 hover:text-foreground" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show ${options.length - SHOWN_OPTIONS} more ${options.length - SHOWN_OPTIONS === 1 ? "version" : "versions"}`}
        </button>
      )}
      {typing && (
        <ChoiceCard tone="own" checked disabled={readOnly} onSelect={() => {}} head={<><PencilLineIcon className="size-3.5" /> Your own value</>}>
          <Input autoFocus value={(choice as { value: string }).value} onChange={e => onChoose({ value: e.target.value })}
            onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
            aria-label={`Value for ${outer.label.join(" ")}`} placeholder="What to publish" />
        </ChoiceCard>
      )}
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {typable && !typing && (
            <ChoiceButton tone="own" pressed={false} onClick={() => onChoose({ value: "" })}>
              <PencilLineIcon className="size-3.5" /> Write my own
            </ChoiceButton>
          )}
          <ChoiceButton tone="later" pressed={choice === "later"} onClick={() => onChoose("later")}>
            <ClockIcon className="size-3.5" /> Skip for now
          </ChoiceButton>
        </div>
      )}
    </div>
  );
}

/**
 * One side of a choice, as a card: who (or "Live") on top, the value under it. Not a button, so a file
 * inside can still be opened; it acts as a radio by click, Enter or Space.
 */
function ChoiceCard({ tone, checked, disabled, onSelect, head, children }: {
  tone: "person" | "live" | "own",
  checked: boolean,
  disabled?: boolean,
  onSelect(): void,
  head: ReactNode,
  children: ReactNode
}) {
  const ring = { person: "shadow-primary hover:shadow-primary", live: "shadow-sky-500 hover:shadow-sky-500", own: "shadow-violet-500 hover:shadow-violet-500" }[tone];
  const color = { person: "text-muted-foreground", live: "text-sky-700 dark:text-sky-300", own: "text-violet-700 dark:text-violet-300" }[tone];
  return (
    <div
      role="radio"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={event => {
        if(disabled || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        onSelect();
      }}
      className={cn("flex flex-col gap-1.5 rounded-[10px] bg-background p-2.5 shadow-[inset_0_0_0_1px] shadow-foreground/10 transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        !disabled && "cursor-pointer hover:shadow-foreground/25", checked && cn("shadow-[inset_0_0_0_2px] hover:shadow-[inset_0_0_0_2px]", ring))}
    >
      <span className={cn("flex min-w-0 items-center gap-2 text-xs", color)}>
        {head}
        {checked && <CheckIcon className="ml-auto size-3.5 shrink-0" aria-hidden />}
      </span>
      {children}
    </div>
  );
}

function ChoiceButton({ pressed, tone = "person", disabled, onClick, title, children }: {
  pressed: boolean,
  tone?: "person" | "live" | "own" | "later",
  disabled?: boolean,
  onClick(): void,
  title?: string,
  children: ReactNode
}) {
  // Each kind of answer has its own color: a person's version the brand's, keeping live a calm blue, later grey.
  const ring = {
    person: "shadow-primary enabled:hover:shadow-primary",
    live: "shadow-sky-500 enabled:hover:shadow-sky-500",
    own: "shadow-violet-500 enabled:hover:shadow-violet-500",
    later: "shadow-foreground/40 enabled:hover:shadow-foreground/40"
  }[tone];
  const text = { person: "", live: "text-sky-700 dark:text-sky-300", own: "text-violet-700 dark:text-violet-300", later: "text-muted-foreground" }[tone];
  return (
    <button type="button" disabled={disabled} aria-pressed={pressed} title={title} onClick={onClick}
      className={cn("inline-flex h-7 max-w-full items-center gap-1.5 rounded-[9px] bg-background px-2 text-sm shadow-[inset_0_0_0_1px] shadow-foreground/10 transition-shadow enabled:hover:shadow-foreground/25 disabled:cursor-default",
        text, pressed && cn("shadow-[inset_0_0_0_2px]", ring))}>
      {pressed && <CheckIcon className="size-3.5" />}
      {children}
    </button>
  );
}

/**
 * One change, shown the way its field needs: a short value as old → new, long text as the words that
 * changed, rich text by its text, media as thumbnails, lists as what was added and removed, blocks by
 * what happened to them. Fields with nothing to show (code, custom widgets) say only that they changed.
 */
export function ChangeView({ change, live, compact }: { change: CheckedChange, live?: unknown, compact?: boolean }) {
  const before = live !== undefined && change.status === "stale" ? live : change.before;
  switch(change.kind) {
    case "add":
      return <BlockLine tone="add" label="Added" value={change.after} />;
    case "remove":
      return <BlockLine tone="remove" label="Removed" value={change.before} />;
    case "move":
      return <span className="text-sm text-muted-foreground">Moved {Number(change.after) < Number(change.before) ? "up" : "down"}, to position {Number(change.after) + 1}</span>;
  }
  if(change.detail === "changed-only" && change.field !== "asset") {
    const a = plainText(before);
    const b = plainText(change.after);
    if(a !== null || b !== null) return a === b ? <Quiet>Formatting changed</Quiet> : <LongDiff before={a ?? ""} after={b ?? ""} compact={compact} />;
    return <Quiet>Changed (this field has no preview)</Quiet>;
  }
  if(change.field === "asset") {
    return (
      <span className="flex flex-wrap items-center gap-2">
        {before !== undefined && <span className="opacity-60"><AssetThumb value={before} /></span>}
        {before !== undefined && <ArrowRightIcon className="size-3.5 text-muted-foreground" />}
        <AssetThumb value={change.after} />
      </span>
    );
  }
  if(change.field === "array" && Array.isArray(change.after)) return <ListDiff change={change} before={Array.isArray(before) ? before : []} />;
  if(typeof change.after === "string" && isLongText(before, change.after)) {
    return <LongDiff before={typeof before === "string" ? before : ""} after={change.after} compact={compact} />;
  }
  if(before === undefined || before === null || before === "") return <span className="text-sm"><Value change={change} value={change.after} /></span>;
  if(change.after === undefined || change.after === null || change.after === "") return <span className="text-sm"><Old><Value change={change} value={before} /></Old> <Quiet>cleared</Quiet></span>;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
      <Old><Value change={change} value={before} /></Old>
      <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 break-words"><Value change={change} value={change.after} /></span>
    </span>
  );
}

/**
 * One side of a choice: just its value, since live shows once on "Keep live". Long text is clamped,
 * media is a thumbnail, and anything structural (a block added or moved) says what happened.
 */
function OptionValue({ change, live }: { change: CheckedChange, live: unknown }) {
  if(change.kind !== "set") return <ChangeView change={change} live={live} compact />;
  if(change.field === "asset") return <AssetThumb value={change.after} stretch />;
  if(change.detail === "changed-only") {
    const text = plainText(change.after);
    return text ? <p className="line-clamp-3 text-sm whitespace-pre-wrap">{text}</p> : <ChangeView change={change} live={live} compact />;
  }
  if(change.field === "asset") return <AssetThumb value={change.after} stretch />;
  if(change.field === "array") return <ChangeView change={change} live={live} compact />;
  return <p className="line-clamp-3 text-sm break-words"><Value change={change} value={change.after} /></p>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}

function Old({ children }: { children: ReactNode }) {
  return <span className="min-w-0 break-words text-muted-foreground line-through decoration-red-500/50">{children}</span>;
}

/** Long text as the words that changed, with a little around each change; "Show all" for the rest. */
function LongDiff({ before, after, compact }: { before: string, after: string, compact?: boolean }) {
  const [full, setFull] = useState(false);
  const parts = useMemo(() => textDiff(before, after), [before, after]);
  const trimmed = useMemo(() => trimDiff(parts, compact ? 5 : 8), [parts, compact]);
  const shown = full ? parts : trimmed.parts;
  const added = parts.filter(p => p.op === "add").reduce((n, p) => n + p.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const removed = parts.filter(p => p.op === "remove").reduce((n, p) => n + p.text.trim().split(/\s+/).filter(Boolean).length, 0);
  return (
    <div className="flex flex-col gap-1">
      <p className={cn("text-sm leading-relaxed whitespace-pre-wrap break-words", full ? "max-h-72 overflow-y-auto" : compact && "line-clamp-4")}>
        {shown.map((part, i) => (
          part.op === "same" ? <span key={i} className="text-muted-foreground">{part.text}</span>
            // A removal right before an addition gets a gap, so "old" and "new" don't read as one word.
            : part.op === "add" ? <ins key={i} className="rounded-[3px] bg-emerald-500/15 text-emerald-900 no-underline dark:text-emerald-200">{part.text}</ins>
              : <del key={i} className={cn("rounded-[3px] bg-red-500/10 text-red-800/80 decoration-red-500/50 dark:text-red-300/80", shown[i + 1]?.op === "add" && "mr-1")}>{part.text}</del>
        ))}
      </p>
      <span className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
        {added > 0 && <span className="text-emerald-700 dark:text-emerald-400">+{added} {added === 1 ? "word" : "words"}</span>}
        {removed > 0 && <span className="text-red-700/80 dark:text-red-400/80">−{removed}</span>}
        {(trimmed.trimmed || full) && (
          <span role="button" tabIndex={0} className="cursor-pointer underline underline-offset-3 hover:text-foreground"
            onClick={event => {
              event.stopPropagation();
              setFull(!full);
            }}
            onKeyDown={event => {
              if(event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                event.stopPropagation();
                setFull(!full);
              }
            }}>
            {full ? "Show only changes" : "Show all"}
          </span>
        )}
      </span>
    </div>
  );
}

/** A list of simple values: what it gains and loses. */
function ListDiff({ change, before }: { change: CheckedChange, before: unknown[] }) {
  const after = change.after as unknown[];
  const was = before.map(v => JSON.stringify(v));
  const now = after.map(v => JSON.stringify(v));
  const added = after.filter((_, i) => !was.includes(now[i]!));
  const removed = before.filter((_, i) => !now.includes(was[i]!));
  if(!added.length && !removed.length) return <Quiet>Reordered</Quiet>;
  return (
    <span className="flex flex-wrap gap-1">
      {added.map((v, i) => <span key={`+${i}`} className="rounded-full bg-emerald-500/12 px-2 text-xs leading-5 text-emerald-800 dark:text-emerald-300">+ <Value change={change} value={v} single /></span>)}
      {removed.map((v, i) => <span key={`-${i}`} className="rounded-full bg-red-500/10 px-2 text-xs leading-5 text-red-800/80 line-through dark:text-red-300/80"><Value change={change} value={v} single /></span>)}
    </span>
  );
}

/** An added or removed block: what kind, and the first thing it says. */
function BlockLine({ tone, label, value }: { tone: "add" | "remove", label: string, value: unknown }) {
  const summary = blockSummary(value);
  return (
    <span className="flex min-w-0 items-center gap-2 text-sm">
      <span className={cn("shrink-0 rounded-full px-1.5 text-[11px] font-medium",
        tone === "add" ? "bg-emerald-500/12 text-emerald-700 dark:text-emerald-400" : "bg-red-500/10 text-red-700 dark:text-red-400")}>{label}</span>
      {summary && <span className={cn("min-w-0 truncate", tone === "remove" ? "text-muted-foreground line-through decoration-red-500/40" : "text-muted-foreground")}>{summary}</span>}
    </span>
  );
}

/** The first readable text in a block: a heading, a quote, the start of its rich text. */
function blockSummary(value: unknown): string | null {
  const text = plainText(value);
  if(text) return text.split("\n")[0]!.slice(0, 120);
  let found: string | null = null;
  function visit(v: unknown) {
    if(found) return;
    if(typeof v === "string" && /\s/.test(v.trim()) && !/^(https?:|\/)/.test(v)) found = v.slice(0, 120);
    else if(Array.isArray(v)) v.forEach(visit);
    else if(v && typeof v === "object") Object.entries(v).forEach(([key, inner]) => key !== "type" && key !== "_key" && visit(inner));
  }
  visit(value);
  return found;
}

/** A value as its field shows it: document titles for references, thumbnails for media. */
export function Value({ change, value, single }: { change: Pick<CheckedChange, "field" | "ref">, value: unknown, single?: boolean }) {
  if(value === undefined || value === null || value === "") return <i>empty</i>;
  const field = single && change.field === "array" ? (change.ref ? "ref" : "text") : change.field;
  if(field === "ref") return <RefTitle to={change.ref} value={value} />;
  if(field === "asset") return <AssetMini value={value} />;
  if(field === "boolean") return <>{value ? "Yes" : "No"}</>;
  if(field === "date" && typeof value === "string") return <>{formatDate(value)}</>;
  if(Array.isArray(value)) return <>{value.map(v => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}</>;
  if(typeof value === "object") return <>{plainText(value) ?? "changed"}</>;
  return <>{String(value)}</>;
}

function RefTitle({ to, value }: { to?: string, value: unknown }) {
  const { cms, config, locale } = useAdmin();
  const target = typeof value === "string" ? { type: to, id: value } : (value as { type?: string, id?: string });
  const doc = useQuery({
    queryKey: ["document", target.type, target.id, locale],
    enabled: Boolean(target.type && target.id),
    queryFn: () => cms.actions.documents.get({ type: target.type!, id: target.id!, locale }),
    retry: false
  });
  if(!target.type || !doc.data) return <>{target.id ?? "a document"}</>;
  return <>{documentTitle(config, target.type, doc.data.draft ?? doc.data.published)}</>;
}

function assetId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? (value as { asset?: string }).asset : undefined;
}

function AssetMini({ value }: { value: unknown }) {
  const asset = useAsset(assetId(value));
  if(!asset.data) return <span className="inline-block size-10 rounded-[8px] well align-middle" />;
  if(asset.data.mime.startsWith("image/")) return <img src={asset.data.url} alt={asset.data.filename} className="inline-block size-10 rounded-[8px] object-cover align-middle" />;
  return <span className="inline-flex items-center gap-1 align-middle"><FileGlyph mime={asset.data.mime} className="size-3.5" />{asset.data.filename}</span>;
}

/** An icon for a kind of file. */
function FileGlyph({ mime, className }: { mime: string, className?: string }) {
  const Icon = mime.startsWith("video/") ? FileVideoIcon
    : mime.startsWith("audio/") ? FileAudioIcon
      : mime === "application/pdf" || mime.startsWith("text/") ? FileTextIcon
        : /zip|tar|compressed/.test(mime) ? FileArchiveIcon : FileIcon;
  return <Icon className={cn("shrink-0 text-muted-foreground", className)} aria-hidden />;
}

/** "Blog/2024/…/brief-02.pdf": the start and the end, which say the most, with the middle left out. */
function middleTruncate(text: string, max = 48): string {
  if(text.length <= max) return text;
  const keep = max - 1;
  return `${text.slice(0, Math.ceil(keep * 0.4))}…${text.slice(text.length - Math.floor(keep * 0.6))}`;
}

/**
 * A file: a preview (the image, a video's first frame, or an icon for its kind) beside its name, kind
 * and size. Not a control itself, so it sits quietly inside a choice; the small link beside it opens the
 * file in the media library, and hovering that link shows where the file lives.
 */
/** `stretch`: fill the width, with the link at the far end, so files in a list of choices line up. */
function AssetThumb({ value, stretch }: { value: unknown, stretch?: boolean }) {
  const asset = useAsset(assetId(value));
  if(value === undefined || value === null) return <Quiet>No file</Quiet>;
  if(!asset.data) return <span className="inline-block h-10 w-48 rounded-[8px] well" />;
  const file = asset.data;
  const tile = "relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-[7px] bg-background shadow-[0_0_0_1px] shadow-foreground/10";
  const path = file.folder ? `${file.folder}/${file.filename}` : file.filename;
  return (
    <span className={cn("flex min-w-0 items-center gap-2.5", stretch ? "w-full" : "max-w-80")}>
      {file.mime.startsWith("image/") ? (
        <img src={file.url} alt="" className={cn(tile, "object-cover")} />
      ) : file.mime.startsWith("video/") ? (
        <span className={cn(tile, "bg-black")}>
          <video src={`${file.url}#t=0.1`} preload="metadata" muted playsInline className="absolute inset-0 size-full object-cover" />
          <PlayIcon className="relative size-4 fill-white text-white drop-shadow" aria-hidden />
        </span>
      ) : (
        <span className={tile}><FileGlyph mime={file.mime} className="size-5" /></span>
      )}
      <span className={cn("flex min-w-0 flex-col", stretch && "flex-1")}>
        <span className="truncate text-sm">{file.filename}</span>
        <span className="truncate text-[11px] text-muted-foreground tabular-nums">{describeAsset(file)}</span>
      </span>
      <Tooltip>
        <TooltipTrigger render={
          <Link to={`/media?file=${encodeURIComponent(file.id)}`} target="_blank" rel="noreferrer"
            onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
            aria-label={`Open ${file.filename} in the media library`}
            className="grid size-6 shrink-0 place-items-center rounded-[6px] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground">
            <ExternalLinkIcon className="size-3.5" />
          </Link>
        } />
        <TooltipContent className="whitespace-nowrap">{middleTruncate(path)}</TooltipContent>
      </Tooltip>
    </span>
  );
}
