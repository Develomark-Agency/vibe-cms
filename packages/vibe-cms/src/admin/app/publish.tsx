import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightIcon, CalendarClockIcon, CloudUploadIcon, GitMergeIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getAt, type CheckedChange } from "../../changes/index.ts";
import type { BranchChanges, DocumentState } from "../../handler/engine.ts";
import type { Via } from "../../handler/activity.ts";
import { Button } from "../components/ui/button.tsx";
import { Checkbox } from "../components/ui/checkbox.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.tsx";
import { Input } from "../components/ui/input.tsx";
import { Skeleton } from "../components/ui/skeleton.tsx";
import { Spinner } from "../components/ui/spinner.tsx";
import { cn } from "../lib/utils.ts";
import { isActionError } from "../../actions/errors.ts";
import { VIA_LABELS } from "./via.ts";
import { displayUser, documentTitle, formatDate, formatRelative, useAdmin } from "./context.tsx";
import { useAsset } from "./pickers.tsx";

/** A change on someone's branch: `owner` + `path` is how publishing names it. */
type Ref = { owner: string, change: CheckedChange };
type Choice = { use: string } | { value: string } | "later";

/** A conflict or stale change, with every side of it. */
interface Group {
  group: string,
  status: "conflict" | "stale",
  sides: Ref[],
  label: string,
  /** What's live at the group's path. */
  live: unknown
}

function keyOf(owner: string, path: string) {
  return `${owner}\u0000${path}`;
}

/**
 * What publishing will do: every person's unpublished changes as sentences, ticked unless they need a
 * choice, and a choice for each conflict. With nothing to choose it's one click to open and one to publish.
 */
export function PublishDialog({ open, onOpenChange, type, id, title, onDone }: {
  open: boolean,
  onOpenChange(open: boolean): void,
  type: string,
  id: string,
  title: string,
  onDone(doc: DocumentState): void
}) {
  const { cms, locale, session } = useAdmin();
  const queryClient = useQueryClient();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const publishButton = useRef<HTMLButtonElement>(null);

  function reset() {
    setUnticked(new Set());
    setChoices(new Map());
  }

  useEffect(() => {
    if(!open) return;
    reset();
    setError(null);
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
  const groups = useMemo(() => groupsOf(changes.data?.live ?? null, branches), [changes.data]);
  const grouped = new Set(groups.flatMap(g => g.sides.map(s => keyOf(s.owner, s.change.path))));

  function included(owner: string, change: CheckedChange): boolean {
    if(change.group && grouped.has(keyOf(owner, change.path))) return (choices.get(change.group) ?? "later") !== "later";
    return !unticked.has(keyOf(owner, change.path));
  }

  const chosen = branches.flatMap(b => b.changes.filter(c => included(b.owner, c)).map(change => ({ owner: b.owner, change })));
  const owners = [...new Set(chosen.map(c => c.owner))];
  // A settled conflict is one change to the page, however many people made it.
  const count = chosen.filter(c => !grouped.has(keyOf(c.owner, c.change.path))).length + [...choices.values()].filter(c => c !== "later").length;
  const counted = count === 1 ? "1 change" : `${count} changes`;
  const missingValue = [...choices.values()].some(choice => typeof choice === "object" && "value" in choice && choice.value === "");

  function toggle(owner: string, paths: string[], on: boolean) {
    setUnticked(prev => {
      const next = new Set(prev);
      for(const path of paths) {
        if(on) next.delete(keyOf(owner, path));
        else next.add(keyOf(owner, path));
      }
      return next;
    });
  }

  /** What's ticked and chosen, as `documents.publish` and `documents.schedule` take it. */
  function selection() {
    const skip = branches.filter(b => owners.includes(b.owner))
      .flatMap(b => b.changes.filter(c => !included(b.owner, c)).map(c => ({ owner: b.owner, path: c.path })));
    const resolve = [...choices.entries()].flatMap(([group, choice]) => (choice === "later" ? [] : [{ group, ...choice }]));
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

  const [scheduling, setScheduling] = useState<string | null>(null);
  useEffect(() => {
    if(!open) setScheduling(null);
  }, [open]);

  const people = owners.map(owner => inSentence(nameOf(owner)));
  const reason = chosen.length === 0 ? "Nothing selected" : missingValue ? "Type the value to publish" : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(88vh,48rem)] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish “{title}”</DialogTitle>
          <DialogDescription>
            {changes.isPending ? "Checking what's changed…"
              : !branches.length ? "There are no unpublished changes."
                : chosen.length === 0 ? "Nothing is selected to publish."
                  : <>{counted} from {list(people)} {count === 1 ? "goes" : "go"} live as one new version.</>}
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-5 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5">
          {changes.isPending && <Skeleton className="h-24 w-full" />}
          {groups.length > 0 && (
            <section className="flex flex-col gap-3">
              <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-amber-700 uppercase dark:text-amber-400">
                <GitMergeIcon className="size-3.5" /> {groups.length === 1 ? "Needs a choice" : `${groups.length} need a choice`}
              </h3>
              {groups.map(group => (
                <GroupCard
                  key={group.group}
                  group={group}
                  nameOf={nameOf}
                  choice={choices.get(group.group) ?? "later"}
                  onChoose={choice => setChoices(prev => new Map(prev).set(group.group, choice))}
                />
              ))}
            </section>
          )}
          {branches.map(branch => (
            <BranchSection
              key={branch.owner}
              branch={branch}
              nameOf={nameOf}
              grouped={grouped}
              included={change => included(branch.owner, change)}
              onToggle={(paths, on) => toggle(branch.owner, paths, on)}
              onDiscard={() => discard(branch.owner)}
            />
          ))}
        </div>

        {scheduling !== null && (
          <div className="flex flex-wrap items-center gap-2 rounded-[14px] bg-violet-500/8 p-3 shadow-[inset_0_0_0_1px] shadow-violet-500/20">
            <CalendarClockIcon className="size-4 text-violet-600" />
            <span>Publish these at</span>
            <Input type="datetime-local" className="w-auto" value={scheduling} onChange={e => setScheduling(e.target.value)} aria-label="When to publish" />
            <span className="basis-full text-xs text-muted-foreground">They're captured now: edits saved later aren't included.</span>
          </div>
        )}

        <DialogFooter className="items-center">
          {(error || reason) && <p className={cn("mr-auto text-xs", error ? "text-destructive" : "text-muted-foreground")}>{error ?? reason}</p>}
          {scheduling === null ? (
            <>
              <Button variant="ghost" disabled={busy || reason !== null} onClick={() => setScheduling(toLocalInput(new Date(Date.now() + 24 * 3600 * 1000)))}>
                <CalendarClockIcon /> Schedule…
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button ref={publishButton} disabled={busy || reason !== null} onClick={() => void publish()}>
                {busy ? <Spinner /> : <CloudUploadIcon />} Publish{count ? ` ${counted}` : ""}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setScheduling(null)}>Back</Button>
              <Button disabled={busy || reason !== null || !scheduling} onClick={() => void publish(new Date(scheduling).toISOString())}>
                {busy ? <Spinner /> : <CalendarClockIcon />} Schedule{count ? ` ${counted}` : ""}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The conflicts and stale changes across branches, by group. */
function groupsOf(live: unknown, branches: BranchChanges[]): Group[] {
  const out = new Map<string, Group>();
  for(const branch of branches) {
    for(const change of branch.changes) {
      if(change.status !== "conflict" && change.status !== "stale") continue;
      const id = change.group ?? change.path;
      const group = out.get(id) ?? { group: id, status: change.status, sides: [], label: "", live: undefined };
      if(change.status === "conflict") group.status = "conflict";
      group.sides.push({ owner: branch.owner, change });
      // Named and valued by the outermost change in it, which is at the group's path.
      const outer = group.sides.reduce((a, b) => (b.change.segments.length < a.change.segments.length ? b : a));
      group.label = outer.change.label.join(" › ");
      group.live = getAt(live, outer.change.segments);
      out.set(id, group);
    }
  }
  return [...out.values()];
}

function toLocalInput(date: Date): string {
  function pad(n: number) {
    return String(n).padStart(2, "0");
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "You" starts a sentence; anywhere else it's "you". */
function inSentence(name: string): string {
  return name === "You" ? "you" : name;
}

function list(names: string[]): string {
  if(names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function Who({ name, via, at }: { name: string, via?: string, at?: string }) {
  const who = name;
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="truncate font-medium">{who}</span>
      {via && via !== "ui" && <span className="shrink-0 text-xs text-muted-foreground">via {VIA_LABELS[via as Via] ?? via}</span>}
      {at && <span className="shrink-0 text-xs text-muted-foreground" title={formatDate(at)}>· {formatRelative(at)}</span>}
    </span>
  );
}

function BranchSection({ branch, nameOf, grouped, included, onToggle, onDiscard }: {
  branch: BranchChanges,
  nameOf(owner: string): string,
  grouped: Set<string>,
  included(change: CheckedChange): boolean,
  onToggle(paths: string[], on: boolean): void,
  onDiscard(): Promise<void>
}) {
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  // The box ticks the changes that aren't waiting on a choice, and shows everything going in, choices included.
  const own = branch.changes.filter(c => !grouped.has(keyOf(branch.owner, c.path)));
  const on = branch.changes.filter(included).length;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <label className="flex min-w-0 flex-1 items-center gap-2.5">
          <Checkbox
            checked={on === branch.changes.length}
            indeterminate={on > 0 && on < branch.changes.length}
            disabled={own.length === 0}
            onCheckedChange={checked => onToggle(own.map(c => c.path), Boolean(checked))}
          />
          <Who name={nameOf(branch.owner)} via={branch.via} at={branch.updatedAt} />
        </label>
        {confirming ? (
          <span className="flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">Throw these away?</span>
            <Button variant="ghost" size="xs" onClick={() => setConfirming(false)}>Keep</Button>
            <Button variant="destructive" size="xs" disabled={discarding} onClick={async () => {
              setDiscarding(true);
              await onDiscard();
              setDiscarding(false);
              setConfirming(false);
            }}>{discarding && <Spinner />} Discard</Button>
          </span>
        ) : (
          <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={() => setConfirming(true)}>
            <Trash2Icon /> Discard
          </Button>
        )}
      </div>
      <ul className="ml-6.5 flex flex-col divide-y rounded-[14px] well">
        {branch.changes.map(change => {
          const inGroup = grouped.has(keyOf(branch.owner, change.path));
          return (
            <li key={change.path} className={cn("flex items-start gap-2.5 px-3 py-2.5", inGroup && "bg-amber-500/5")}>
              {inGroup
                ? <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-amber-600" aria-label="Needs a choice" />
                : <Checkbox className="mt-0.5" checked={included(change)} onCheckedChange={checked => onToggle([change.path], Boolean(checked))} />}
              <ChangeLine change={change} />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Changed Title", with the before and after underneath when the field can show them. */
function ChangeLine({ change }: { change: CheckedChange }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <span>{sentence(change)}</span>
      {change.kind === "set" && change.detail === "value" && change.before !== undefined && change.after !== undefined && (
        <ValueDiff change={change} />
      )}
      {change.kind === "set" && change.detail === "value" && change.before === undefined && change.after !== undefined && (
        <span className="text-muted-foreground"><Value change={change} value={change.after} /></span>
      )}
    </div>
  );
}

function sentence(change: CheckedChange): ReactNode {
  const label = change.label.join(" › ") || "Document";
  const item = change.label.at(-1) ?? "item";
  const parent = change.label.slice(0, -1).join(" › ");
  switch(change.kind) {
    case "add": return <>Added <b className="font-medium">{item}</b>{parent && <> to {parent}</>}</>;
    case "remove": return <>Removed <b className="font-medium">{item}</b>{parent && <> from {parent}</>}</>;
    case "move": return <>Moved <b className="font-medium">{item}</b> {Number(change.after) < Number(change.before) ? "up" : "down"}{parent && <> in {parent}</>}</>;
    case "set":
      if(change.before === undefined) return <>Set <b className="font-medium">{label}</b></>;
      if(change.after === undefined || change.after === "") return <>Cleared <b className="font-medium">{label}</b></>;
      return <>Changed <b className="font-medium">{label}</b></>;
  }
}

function ValueDiff({ change }: { change: CheckedChange }) {
  if(change.field === "array" && Array.isArray(change.before) && Array.isArray(change.after)) {
    const before = change.before.map(v => JSON.stringify(v));
    const after = change.after.map(v => JSON.stringify(v));
    const added = change.after.filter((_, i) => !before.includes(after[i]!));
    const removed = change.before.filter((_, i) => !after.includes(before[i]!));
    return (
      <span className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {added.map((v, i) => <span key={`+${i}`} className="text-emerald-700 dark:text-emerald-400">+ <Value change={change} value={v} single /></span>)}
        {removed.map((v, i) => <span key={`-${i}`} className="line-through">− <Value change={change} value={v} single /></span>)}
        {!added.length && !removed.length && "Reordered"}
      </span>
    );
  }
  const inline = change.field !== "text";
  return (
    <span className={cn("flex gap-1.5 text-muted-foreground", inline ? "flex-wrap items-center" : "flex-col")}>
      <span className="line-clamp-3 line-through decoration-muted-foreground/60"><Value change={change} value={change.before} /></span>
      {inline && <ArrowRightIcon className="size-3.5 shrink-0" />}
      <span className="line-clamp-3 text-foreground"><Value change={change} value={change.after} /></span>
    </span>
  );
}

/** A value as its field shows it: document titles for references, thumbnails for media. */
function Value({ change, value, single }: { change: Pick<CheckedChange, "field" | "ref">, value: unknown, single?: boolean }) {
  if(value === undefined || value === null || value === "") return <i>empty</i>;
  const field = single && change.field === "array" ? (change.ref ? "ref" : "text") : change.field;
  if(field === "ref") return <RefTitle to={change.ref} value={value} />;
  if(field === "asset") return <AssetMini value={value} />;
  if(field === "boolean") return <>{value ? "Yes" : "No"}</>;
  if(field === "date" && typeof value === "string") return <>{formatDate(value)}</>;
  if(Array.isArray(value)) return <>{value.map(v => (typeof v === "string" ? v : JSON.stringify(v))).join(", ")}</>;
  if(typeof value === "object") return <>changed</>;
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

function AssetMini({ value }: { value: unknown }) {
  const id = typeof value === "object" && value !== null ? (value as { asset?: string }).asset : undefined;
  const asset = useAsset(id);
  if(!asset.data) return <span className="inline-block size-10 rounded-[8px] well align-middle" />;
  if(asset.data.mime.startsWith("image/")) return <img src={asset.data.url} alt={asset.data.filename} className="inline-block size-10 rounded-[8px] object-cover align-middle" />;
  return <>{asset.data.filename}</>;
}

function GroupCard({ group, nameOf, choice, onChoose }: { group: Group, nameOf(owner: string): string, choice: Choice, onChoose(choice: Choice): void }) {
  const owners = [...new Set(group.sides.map(s => s.owner))];
  const names = owners.map(owner => nameOf(owner));
  const outer = group.sides.reduce((a, b) => (b.change.segments.length < a.change.segments.length ? b : a)).change;
  const typable = outer.kind === "set" && outer.detail === "value" && outer.field === "text";
  function selected(option: Choice) {
    return JSON.stringify(option) === JSON.stringify(choice) || (typeof option === "object" && "value" in option && typeof choice === "object" && "value" in choice);
  }
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-amber-500/8 p-3 shadow-[inset_0_0_0_1px] shadow-amber-500/25">
      <p>
        <b className="font-medium">{group.label}</b>
        <span className="text-muted-foreground">
          {group.status === "conflict" ? ` — ${list(names.map((n, i) => (i ? inSentence(n) : n)))} both changed this.` : ` — published as something else since ${inSentence(names[0]!)} changed it.`}
        </span>
      </p>
      <div className="flex flex-col gap-1">
        {owners.map(owner => {
          const sides = group.sides.filter(s => s.owner === owner);
          return (
            <Option key={owner} name={group.group} checked={selected({ use: owner })} onSelect={() => onChoose({ use: owner })}>
              <span className="flex flex-col gap-0.5">
                <Who name={nameOf(owner)} />
                {sides.map(side => (
                  <span key={side.change.path} className="text-muted-foreground">
                    {side.change.kind === "set" && side.change.detail === "value" ? <Value change={side.change} value={side.change.after} /> : sentence(side.change)}
                  </span>
                ))}
              </span>
            </Option>
          );
        })}
        <Option name={group.group} checked={selected({ use: "live" })} onSelect={() => onChoose({ use: "live" })}>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Keep what's live</span>
            {outer.detail === "value" && <span className="text-muted-foreground"><Value change={outer} value={group.live} /></span>}
          </span>
        </Option>
        {typable && (
          <Option name={group.group} checked={selected({ value: "" })} onSelect={() => onChoose({ value: typeof choice === "object" && "value" in choice ? choice.value : "" })}>
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="font-medium">Something else</span>
              {typeof choice === "object" && "value" in choice && (
                <Input autoFocus value={choice.value} onChange={e => onChoose({ value: e.target.value })} aria-label={`New value for ${group.label}`} />
              )}
            </span>
          </Option>
        )}
        <Option name={group.group} checked={choice === "later"} onSelect={() => onChoose("later")}>
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Decide later</span>
            <span className="text-muted-foreground">Leave these changes unpublished</span>
          </span>
        </Option>
      </div>
    </div>
  );
}

function Option({ name, checked, onSelect, children }: { name: string, checked: boolean, onSelect(): void, children: ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 rounded-[10px] px-2 py-1.5 hover:bg-foreground/4", checked && "bg-background shadow-[inset_0_0_0_1px] shadow-foreground/10")}>
      <input type="radio" name={name} className="mt-1 accent-primary" checked={checked} onChange={onSelect} />
      {children}
    </label>
  );
}
