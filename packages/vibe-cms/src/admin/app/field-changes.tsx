import { createContext, useContext, useMemo, type ReactNode } from "react";
import { assignKeys, deepEqual, diff, getAt, type Change, type Detail, type Segment } from "../../changes/index.ts";
import type { BranchChanges } from "../../handler/engine.ts";
import type { Via } from "../../handler/activity.ts";
import type { Path } from "../../schema/validate.ts";
import type { ObjectSchema } from "../../schema/types.ts";
import { Button } from "../components/ui/button.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { displayUser, formatDate, formatRelative, useAdmin } from "./context.tsx";
import { Value } from "./publish.tsx";
import { VIA_LABELS } from "./via.ts";

/** One field's values: live, yours when you changed it, and other people's unpublished ones. */
export interface FieldChange {
  field: string,
  ref?: string,
  detail: Detail,
  /** `undefined` when the document (or this field) isn't live. */
  live: unknown,
  mine?: { value: unknown, unsaved: boolean, kind: Change["kind"] },
  others: Array<{ owner: string, name: string | null, via: string, updatedAt: string, value: unknown, kind: Change["kind"] }>
}

export interface FieldChanges {
  /** The field at this form path, when anyone changed it. */
  at(path: Path): FieldChange | null,
  /** Whether anything inside this path changed, and by whom: for a collapsed block's header. */
  inside(path: Path): { mine: boolean, others: boolean } | null
}

const FieldChangesContext = createContext<FieldChanges | null>(null);

export function FieldChangesProvider({ value, children }: { value: FieldChanges | null, children: ReactNode }) {
  return <FieldChangesContext.Provider value={value}>{children}</FieldChangesContext.Provider>;
}

function pathKey(path: Path): string {
  return path.join(".");
}

/** A change's path as the form names it: list items by position in `doc`, not by key. Null when `doc` doesn't have it. */
function formPath(segments: Segment[], doc: unknown): Path | null {
  const out: Path = [];
  for(const [i, segment] of segments.entries()) {
    if(typeof segment === "string" || typeof segment === "number") {
      out.push(segment);
      continue;
    }
    const list = getAt(doc, segments.slice(0, i));
    const index = Array.isArray(list) ? list.findIndex(item => (item as { _key?: string } | null)?._key === segment.key) : -1;
    if(index < 0) return null;
    out.push(index);
  }
  return out;
}

/**
 * Works out every changed field of the form: yours against live (unsaved edits included), and each
 * other person's unpublished changes, placed on the form by your copy's blocks.
 */
export function useFieldChanges(input: {
  schema: ObjectSchema,
  published: unknown,
  saved: unknown,
  value: unknown,
  /** Everyone's branches, from `documents.changes`; yours is left out. */
  branches: BranchChanges[] | undefined,
  me: string
}): FieldChanges | null {
  const { schema, published, saved, value, branches, me } = input;
  return useMemo(() => {
    // A document that was never published has nothing to compare against: everything in it is new.
    if(!value || !published) return null;
    // Blocks added since the last save have no key yet; give them one so they diff as additions.
    const form = structuredClone(value);
    let n = 0;
    assignKeys(schema, form, () => `unsaved-${n++}`);
    const entries = new Map<string, FieldChange>();
    const inside = new Map<string, { mine: boolean, others: boolean }>();
    function entry(path: Path, change: Change): FieldChange {
      const key = pathKey(path);
      let found = entries.get(key);
      if(!found) {
        found = { field: change.field, ref: change.ref, detail: change.detail, live: published ? getAt(published, change.segments) : undefined, others: [] };
        entries.set(key, found);
      }
      return found;
    }
    function mark(path: Path, who: "mine" | "others") {
      for(let i = 1; i < path.length; i++) {
        const key = pathKey(path.slice(0, i));
        const seen = inside.get(key) ?? { mine: false, others: false };
        seen[who] = true;
        inside.set(key, seen);
      }
    }
    // Before the first publish, yours are the changes against the copy you started from.
    for(const change of diff(schema, published ?? {}, form)) {
      const path = formPath(change.segments, form);
      if(!path || change.kind === "remove") continue;
      entry(path, change).mine = { value: change.after, unsaved: !deepEqual(getAt(saved, change.segments), change.after), kind: change.kind };
      mark(path, "mine");
    }
    if(published) {
      for(const branch of branches ?? []) {
        if(branch.owner === me) continue;
        for(const change of branch.changes) {
          // A block only they have shows on the list it would join.
          const path = formPath(change.kind === "add" ? change.segments.slice(0, -1) : change.segments, form);
          if(!path) continue;
          entry(path, change).others.push({ owner: branch.owner, name: branch.name, via: branch.via, updatedAt: branch.updatedAt, value: change.after, kind: change.kind });
          mark(path, "others");
        }
      }
    }
    return {
      at: path => entries.get(pathKey(path)) ?? null,
      inside: path => inside.get(pathKey(path)) ?? null
    };
  }, [schema, published, saved, value, branches, me]);
}

function tone(mine: boolean, others: boolean) {
  return others ? "bg-amber-500" : mine ? "bg-primary" : "";
}

/** A dot on a collapsed block's header when something inside it changed. */
export function ChangedInside({ path }: { path: Path }) {
  const changes = useContext(FieldChangesContext);
  const found = changes?.inside(path) ?? changes?.at(path);
  if(!found) return null;
  const mine = "mine" in found && Boolean(found.mine);
  const others = "others" in found && (Array.isArray(found.others) ? found.others.length > 0 : Boolean(found.others));
  if(!mine && !others) return null;
  return <span className={cn("size-1.5 shrink-0 rounded-full", tone(mine, others))} title={others ? "Changed by someone else too" : "You changed this"} />;
}

/** This field's changes, if anyone made any: for the bar down its left edge. */
export function useFieldChange(path: Path): FieldChange | null {
  const found = useContext(FieldChangesContext)?.at(path);
  return found && (found.mine || found.others.length) ? found : null;
}

/** The bar's color class: amber when someone else changed the field, else yours. */
export function changeTone(found: FieldChange): string {
  return tone(Boolean(found.mine), found.others.length > 0);
}

/** "Bob", "Bob and Ana", "Bob, Ana and 18 others". */
function namesSentence(names: string[]): string {
  if(names.length <= 2) return names.join(" and ");
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/**
 * Under a field anyone changed: a line saying who ("Bob and Ana changed this", "You changed this · not
 * saved") that opens the live value, yours, and everyone else's, grouped by value, with a button to use any.
 */
export function FieldChangeMarker({ path, onUse, readOnly }: { path: Path, onUse(value: unknown): void, readOnly?: boolean }) {
  const { session } = useAdmin();
  const found = useFieldChange(path);
  if(!found) return null;
  function nameOf(other: FieldChange["others"][number]) {
    return other.name ?? displayUser(other.owner, session);
  }
  const others = found.others.map(nameOf);
  // A full name alone; first names once there are several.
  const short = others.length > 1 || found.mine ? others.map(n => n.split(/\s+/)[0]!) : others;
  const sentence = others.length
    ? `${namesSentence(found.mine ? ["You", ...short] : short)} changed this`
    : `You changed this · ${found.mine!.unsaved ? "not saved" : "not published"}`;
  function settable(kind: Change["kind"]) {
    return !readOnly && kind === "set";
  }
  // Twenty people rarely type twenty different things: one row per value, most popular first.
  const groups = new Map<string, FieldChange["others"]>();
  for(const other of found.others) {
    const key = other.kind === "set" ? JSON.stringify(other.value ?? null) : `${other.kind}:${other.owner}`;
    groups.set(key, [...(groups.get(key) ?? []), other]);
  }
  const rows = [...groups.values()].sort((a, b) => b.length - a.length);
  return (
    <Popover>
      <PopoverTrigger render={
        <button type="button" className="flex w-fit items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
          <span className={cn("size-1.5 shrink-0 rounded-full", changeTone(found))} />
          <span className="underline decoration-border underline-offset-3">{sentence}</span>
        </button>
      } />
      <PopoverContent align="start" className="w-80 gap-0 p-0">
        {found.others.length > 1 && (
          <p className="bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            {found.others.length} people, {rows.length === 1 ? "1 version" : `${rows.length} different versions`}
          </p>
        )}
        <ul className="max-h-80 divide-y overflow-y-auto text-sm">
          <Row title="Live"
            onUse={found.mine && settable(found.mine.kind) && found.live !== undefined ? () => onUse(found.live) : undefined} useLabel="Undo yours">
            {found.live === undefined ? <i className="text-muted-foreground">Not live yet</i> : <Shown change={found} value={found.live} />}
          </Row>
          {found.mine && (
            <Row title="You" detail={found.mine.unsaved ? "Not saved" : "Saved, not published"} current>
              <Shown change={found} value={found.mine.value} kind={found.mine.kind} />
            </Row>
          )}
          {rows.map(group => {
            const first = group[0]!;
            const single = group.length === 1;
            return (
              <Row
                key={`${first.owner}`}
                title={single ? nameOf(first) : `${group.length} people`}
                detail={single
                  ? `${first.via !== "ui" ? `via ${VIA_LABELS[first.via as Via] ?? first.via} · ` : ""}${formatRelative(first.updatedAt)}`
                  : namesSentence(group.map(o => nameOf(o).split(/\s+/)[0]!))}
                detailTitle={single ? formatDate(first.updatedAt) : group.map(nameOf).join(", ")}
                onUse={settable(first.kind) ? () => onUse(first.value) : undefined}
              >
                <Shown change={found} value={first.value} kind={first.kind} />
              </Row>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function Shown({ change, value, kind }: { change: FieldChange, value: unknown, kind?: Change["kind"] }) {
  if(kind === "add") return <span className="text-muted-foreground">Added a block here</span>;
  if(kind === "move") return <span className="text-muted-foreground">Moved this block</span>;
  if(change.detail === "changed-only") return <span className="text-muted-foreground">Changed (no preview for this field)</span>;
  return <span className="line-clamp-4 break-words"><Value change={change} value={value} /></span>;
}

function Row({ title, detail, detailTitle, current, onUse, useLabel = "Use", children }: {
  title: string,
  detail?: string | null,
  detailTitle?: string,
  current?: boolean,
  onUse?: () => void,
  useLabel?: string,
  children: ReactNode
}) {
  return (
    <li className={cn("flex flex-col gap-1 px-3 py-2.5", current && "bg-primary/5")}>
      <div className="flex items-center gap-2">
        <span className="font-medium">{title}</span>
        {detail && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={detailTitle}>{detail}</span>}
        {onUse && <Button variant="ghost" size="xs" className="ml-auto" onClick={onUse}>{useLabel}</Button>}
      </div>
      {children}
    </li>
  );
}
