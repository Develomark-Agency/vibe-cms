/**
 * Change sets: what each person's branch of a document changes against the version it started from,
 * whether each change still applies to the live version, and the merge that publishing writes.
 *
 * Pure functions over schemas and JSON, shared by the engine and the editor. See `.docs/change-sets.md`.
 */
import type { AnySchema, ArraySchema, LiteralSchema, ObjectSchema, OptionalSchema, RefSchema, UnionSchema } from "../schema/types.ts";

type Json = unknown;

/** A step into a value: an object key, an item of a keyed list by its `_key`, or a list position. */
export type Segment = string | { key: string } | number;

/** Fields that can show before and after. Anything else (rich text, code, widgets) shows only that it changed. */
export type Detail = "value" | "changed-only";

export interface Change {
  /** `title`, `seo.description`, `blocks[b_8f2].heading`, `tags`. Unique within one branch's changes. */
  path: string,
  segments: Segment[],
  kind: "set" | "add" | "remove" | "move",
  /** The value at the branch's base; `undefined` for an add. For a move, the item's position. */
  before: Json,
  /** The value on the branch; `undefined` for a remove. For a move, the item's new position. */
  after: Json,
  detail: Detail,
  /** Field labels from the root, e.g. `["Blocks", "Hero", "Heading"]`. */
  label: string[],
  /** The field's schema type, for choosing how to show it: `text`, `ref`, `asset`, `array`, `block`… */
  field: string,
  /** For a reference, or a list of them: the content type it points at, when the field names one. */
  ref?: string
}

/** The key list items are matched by across versions. Blocks carry one. */
export const ITEM_KEY = "_key";

// --- Schema helpers -----------------------------------------------------------

function unwrap(schema: AnySchema): AnySchema {
  return schema.type === "optional" ? unwrap((schema as OptionalSchema).inner) : schema;
}

function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The union option (or the object) a value belongs to, by its literal fields. */
function optionFor(schema: AnySchema, value: unknown): ObjectSchema | null {
  const s = unwrap(schema);
  if(s.type === "object") return s as ObjectSchema;
  if(s.type !== "union" || !isRecord(value)) return null;
  for(const option of (s as UnionSchema).options) {
    const o = unwrap(option);
    if(o.type !== "object") continue;
    const literals = Object.entries((o as ObjectSchema).shape).filter(([, f]) => f.type === "literal");
    if(literals.length && literals.every(([key, f]) => value[key] === (f as LiteralSchema).value)) return o as ObjectSchema;
  }
  return null;
}

/** Whether a list's items are objects that declare `_key`, so they can be matched across versions. */
export function isKeyedList(schema: AnySchema): boolean {
  const s = unwrap(schema);
  if(s.type !== "array") return false;
  const item = unwrap((s as ArraySchema).item);
  const options = item.type === "union" ? (item as UnionSchema).options.map(unwrap) : [item];
  return options.length > 0 && options.every(o => o.type === "object" && ITEM_KEY in (o as ObjectSchema).shape);
}

function isSystemField(schema: AnySchema): boolean {
  return Boolean(schema.hidden || schema.readOnly || unwrap(schema).hidden || unwrap(schema).readOnly);
}

const SIMPLE = new Set(["text", "number", "boolean", "date", "enum", "literal", "ref", "asset"]);

function detailOf(schema: AnySchema): Detail {
  const s = unwrap(schema);
  if(s.widget) return "changed-only";
  if(SIMPLE.has(s.type)) return "value";
  if(s.type === "array") {
    const item = unwrap((s as ArraySchema).item);
    return !item.widget && SIMPLE.has(item.type) ? "value" : "changed-only";
  }
  return "changed-only";
}

// --- Values -------------------------------------------------------------------

export function deepEqual(a: unknown, b: unknown): boolean {
  if(a === b) return true;
  if(typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if(Array.isArray(a) !== Array.isArray(b)) return false;
  if(Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => deepEqual(item, other[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for(const key of keys) if(!deepEqual(ra[key], rb[key])) return false;
  return true;
}

export function pathString(segments: Segment[]): string {
  let out = "";
  for(const segment of segments) {
    if(typeof segment === "string") out += out ? `.${segment}` : segment;
    else if(typeof segment === "number") out += `[${segment}]`;
    else out += `[${segment.key}]`;
  }
  return out;
}

function itemKey(item: unknown): string | null {
  return isRecord(item) && typeof item[ITEM_KEY] === "string" && item[ITEM_KEY] ? item[ITEM_KEY] as string : null;
}

/** Whether every item of both lists has a distinct key, so they can be matched by it. */
function keyable(...lists: unknown[][]): boolean {
  return lists.every(list => {
    const keys = list.map(itemKey);
    return keys.every(Boolean) && new Set(keys).size === keys.length;
  });
}

function step(value: unknown, segment: Segment): unknown {
  if(typeof segment === "string") return isRecord(value) ? value[segment] : undefined;
  if(!Array.isArray(value)) return undefined;
  if(typeof segment === "number") return value[segment];
  return value.find(item => itemKey(item) === segment.key);
}

/** The value at a path, or `undefined` when the path doesn't exist (a removed block, a missing key). */
export function getAt(value: unknown, segments: Segment[]): unknown {
  let current = value;
  for(const segment of segments) {
    current = step(current, segment);
    if(current === undefined) return undefined;
  }
  return current;
}

/** Whether every container on the way to the path exists, so a value can be set there. */
function parentExists(value: unknown, segments: Segment[]): boolean {
  return segments.length === 0 || getAt(value, segments.slice(0, -1)) !== undefined;
}

// --- Diff ---------------------------------------------------------------------

/** What `after` changes against `before`, field by field, following the schema. */
export function diff(schema: AnySchema, before: unknown, after: unknown): Change[] {
  const out: Change[] = [];
  walk(schema, before, after, [], [], out);
  return out;
}

function walk(schema: AnySchema, before: unknown, after: unknown, segments: Segment[], label: string[], out: Change[]) {
  if(deepEqual(before, after)) return;
  const s = unwrap(schema);
  function push(kind: Change["kind"], b: unknown, a: unknown, detail: Detail, field: string) {
    out.push({ path: pathString(segments), segments, kind, before: b, after: a, detail, label, field });
  }

  if(!s.widget && s.type === "object" && isRecord(before) && isRecord(after)) {
    for(const [key, field] of Object.entries((s as ObjectSchema).shape)) {
      // Hidden and read-only fields are the system's: plugins derive them again when publishing.
      if(key === ITEM_KEY || isSystemField(field)) continue;
      walk(field, before[key], after[key], [...segments, key], [...label, field.label ?? humanize(key)], out);
    }
    return;
  }
  if(!s.widget && s.type === "union" && isRecord(before) && isRecord(after)) {
    const option = optionFor(s, before);
    if(option && option === optionFor(s, after)) return walk(option, before, after, segments, label, out);
    return push("set", before, after, "changed-only", "block");
  }
  if(!s.widget && s.type === "array" && Array.isArray(before) && Array.isArray(after) && isKeyedList(s) && keyable(before, after)) {
    return diffList(s as ArraySchema, before, after, segments, label, out);
  }
  const target = s.type === "array" ? unwrap((s as ArraySchema).item) : s;
  const ref = target.type === "ref" ? (target as RefSchema).to : undefined;
  out.push({ path: pathString(segments), segments, kind: "set", before, after, detail: detailOf(s), label, field: s.type, ...(ref ? { ref } : {}) });
}

/** The label of a list item: its block or object label. */
function itemLabel(list: ArraySchema, item: unknown): string {
  return optionFor(list.item, item)?.label ?? "Item";
}

function diffList(list: ArraySchema, before: unknown[], after: unknown[], segments: Segment[], label: string[], out: Change[]) {
  const beforeKeys = before.map(item => itemKey(item)!);
  const afterKeys = after.map(item => itemKey(item)!);
  const beforeSet = new Set(beforeKeys);
  const afterSet = new Set(afterKeys);
  function at(key: string): Segment[] {
    return [...segments, { key }];
  }
  for(const [i, key] of beforeKeys.entries()) {
    if(afterSet.has(key)) continue;
    out.push({ path: pathString(at(key)), segments: at(key), kind: "remove", before: before[i], after: undefined, detail: "changed-only", label: [...label, itemLabel(list, before[i])], field: "block" });
  }
  // Items that kept their place relative to each other aren't moved; the rest are.
  const common = afterKeys.filter(key => beforeSet.has(key));
  const stay = longestIncreasing(common.map(key => beforeKeys.indexOf(key)));
  const stayKeys = new Set(stay.map(i => beforeKeys[i]!));
  for(const [i, key] of afterKeys.entries()) {
    const item = after[i];
    const itemLabels = [...label, itemLabel(list, item)];
    if(!beforeSet.has(key)) {
      out.push({ path: pathString(at(key)), segments: at(key), kind: "add", before: undefined, after: item, detail: "changed-only", label: itemLabels, field: "block" });
      continue;
    }
    if(!stayKeys.has(key)) {
      out.push({ path: pathString(at(key)), segments: at(key), kind: "move", before: beforeKeys.indexOf(key), after: i, detail: "value", label: itemLabels, field: "block" });
    }
    walk(list.item, before[beforeKeys.indexOf(key)], item, at(key), itemLabels, out);
  }
}

/** Indices (into `values`' values) of a longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): number[] {
  const tails: number[] = [];
  const prev: number[] = Array.from({ length: values.length }, () => -1);
  for(const [i, value] of values.entries()) {
    let lo = 0;
    let hi = tails.length;
    while(lo < hi) {
      const mid = (lo + hi) >> 1;
      if(values[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    if(lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const out: number[] = [];
  for(let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) out.unshift(values[i]!);
  return out;
}

// --- Applying -----------------------------------------------------------------

/**
 * Applies one change to a copy of `target`, placing added and moved items after the item that
 * precedes them on the branch (`branch`). Returns `null` when the change no longer has anywhere to go,
 * e.g. an edit inside a block that's since been removed.
 */
export function applyChange(target: unknown, change: Change, branch: unknown): unknown | null {
  const doc = structuredClone(target);
  const parentPath = change.segments.slice(0, -1);
  const last = change.segments[change.segments.length - 1];
  if(change.kind === "set") {
    if(change.segments.length === 0) return structuredClone(change.after);
    if(!parentExists(doc, change.segments)) return null;
    const parent = getAt(doc, parentPath);
    if(typeof last === "string" && isRecord(parent)) {
      if(change.after === undefined) delete parent[last];
      else parent[last] = structuredClone(change.after);
      return doc;
    }
    if(Array.isArray(parent)) {
      const index = typeof last === "number" ? last : parent.findIndex(item => itemKey(item) === (last as { key: string }).key);
      if(index < 0 || index >= parent.length) return null;
      parent[index] = structuredClone(change.after);
      return doc;
    }
    return null;
  }
  const list = getAt(doc, parentPath);
  if(!Array.isArray(list) || typeof last !== "object") return null;
  const key = last.key;
  const index = list.findIndex(item => itemKey(item) === key);
  if(change.kind === "remove") {
    if(index >= 0) list.splice(index, 1);
    return doc;
  }
  const item = change.kind === "add" ? structuredClone(change.after) : list[index];
  if(item === undefined) return null;
  if(index >= 0) list.splice(index, 1);
  // After the nearest item before it on the branch that the target also has; first otherwise.
  const branchList = getAt(branch, parentPath);
  const branchKeys = Array.isArray(branchList) ? branchList.map(itemKey) : [];
  let insertAt = 0;
  for(let i = branchKeys.indexOf(key) - 1; i >= 0; i--) {
    const found = list.findIndex(other => itemKey(other) === branchKeys[i]);
    if(found >= 0) {
      insertAt = found + 1;
      break;
    }
  }
  list.splice(insertAt, 0, item);
  return doc;
}

// --- Checking against live ----------------------------------------------------

/**
 * - `clean`: applies to live as is.
 * - `live`: live already has this change (someone published the same thing).
 * - `stale`: live changed this since the branch started.
 * - `conflict`: another selected branch changes the same thing differently.
 */
export type ChangeStatus = "clean" | "live" | "stale" | "conflict";

export interface Branch {
  owner: string,
  /** The version the branch started from: `null` before the first publish. */
  base: unknown,
  data: unknown
}

export interface CheckedChange extends Change {
  status: ChangeStatus,
  /** The live value at the path, for stale changes. */
  live?: unknown,
  /** Other owners changing the same thing, for conflicts. */
  with?: string[],
  /** The conflict this change is part of: the outermost path involved, the same for every side. */
  group?: string
}

/** Whether two paths touch the same data: equal, or one inside the other. */
function overlaps(a: Segment[], b: Segment[]): boolean {
  const n = Math.min(a.length, b.length);
  for(let i = 0; i < n; i++) if(pathString([a[i]!]) !== pathString([b[i]!])) return false;
  return true;
}

function collides(a: Change, b: Change): boolean {
  if(!overlaps(a.segments, b.segments)) return false;
  // A move only changes where a block sits, so it doesn't touch edits inside it.
  if(a.kind === "move" || b.kind === "move") {
    if(a.kind === "move" && b.kind === "move") return a.path === b.path;
    const [move, other] = a.kind === "move" ? [a, b] : [b, a];
    return other.kind === "remove" && other.path === move.path;
  }
  // The same edit made twice isn't a conflict.
  if(a.path === b.path && a.kind === b.kind && deepEqual(a.after, b.after)) return false;
  // Nor is an edit made on top of the other (someone building on a copy that isn't published yet).
  const [outer, inner] = a.segments.length <= b.segments.length ? [a, b] : [b, a];
  if(outer.segments.length < inner.segments.length && outer.kind !== "remove" && inner.kind === "set") {
    const underneath = getAt(outer.after, inner.segments.slice(outer.segments.length));
    if(deepEqual(underneath, inner.before)) return false;
  }
  return true;
}

/** Whether live still holds what the branch changed from. */
function liveStatus(change: Change, live: unknown): { status: "clean" | "live" | "stale", live?: unknown } {
  // Before the first publish there's nothing live to have moved on.
  if(live === null || live === undefined) return { status: "clean" };
  const current = getAt(live, change.segments);
  switch(change.kind) {
    case "add":
      return current === undefined ? { status: parentExists(live, change.segments) ? "clean" : "stale" } : { status: "live" };
    case "remove":
      if(current === undefined) return { status: "live" };
      return deepEqual(current, change.before) ? { status: "clean" } : { status: "stale", live: current };
    case "move":
      return current === undefined ? { status: "stale", live: undefined } : { status: "clean" };
    case "set":
      if(deepEqual(current, change.after)) return { status: "live" };
      if(deepEqual(current, change.before)) return { status: "clean" };
      return { status: "stale", live: current };
  }
}

/**
 * Every branch's changes, each checked against live and against the other branches. Only `selected`
 * changes (`owner` → paths; all when omitted) can conflict with each other.
 */
export function check(schema: AnySchema, live: unknown, branches: Branch[], selected?: (owner: string, path: string) => boolean): Map<string, CheckedChange[]> {
  const out = new Map<string, CheckedChange[]>();
  for(const branch of branches) {
    const base = branch.base ?? emptyLike(branch.data);
    out.set(branch.owner, diff(schema, base, branch.data).map(change => ({ ...change, ...liveStatus(change, live) })));
  }
  const active = [...out.entries()].flatMap(([owner, changes]) => changes
    .filter(c => c.status !== "live" && (!selected || selected(owner, c.path)))
    .map(change => ({ owner, change })));
  for(const [i, a] of active.entries()) {
    for(const b of active.slice(i + 1)) {
      if(a.owner === b.owner || !collides(a.change, b.change)) continue;
      for(const [side, other] of [[a, b], [b, a]] as const) {
        side.change.status = "conflict";
        side.change.with = [...new Set([...side.change.with ?? [], other.owner])];
      }
    }
  }
  // Group each conflict under the outermost path involved, so both sides resolve together.
  const conflicted = active.filter(entry => entry.change.status === "conflict");
  for(const entry of conflicted) {
    let group = entry.change.segments;
    for(const other of conflicted) if(overlaps(group, other.change.segments) && other.change.segments.length < group.length) group = other.change.segments;
    entry.change.group = pathString(group);
  }
  for(const entry of active) if(entry.change.status === "stale") entry.change.group = entry.change.path;
  return out;
}

/** A new document's branch has no base; it diffs against an empty object. */
function emptyLike(value: unknown): unknown {
  return isRecord(value) ? {} : undefined;
}

// --- Merging ------------------------------------------------------------------

/** How to settle a conflict or a stale change, by its `group`: one owner's side, live, or a value typed in. */
export type Resolution = { use: string } | { use: "live" } | { value: unknown };

export interface MergeInput {
  branches: Branch[],
  /** Owner → paths to leave pending. Everything else on these branches is published. */
  skip?: Map<string, Set<string>>,
  /** Group → how to settle it. */
  resolve?: Map<string, Resolution>
}

export interface MergeResult {
  data: unknown,
  /** Groups still needing a resolution. Publishing refuses while there are any. */
  unresolved: Array<{ group: string, status: "stale" | "conflict", changes: Array<{ owner: string, change: CheckedChange }> }>,
  /** Owner → the branch's data after publishing: what's left pending, on top of the new live. `null` when nothing is. */
  rebased: Map<string, unknown | null>,
  /** Owner → the changes left pending, for `rebase` onto what was finally published. */
  pending: Map<string, Change[]>,
  /** Owner → the paths that went live (or were settled against). */
  published: Map<string, string[]>
}

export function merge(schema: AnySchema, live: unknown, input: MergeInput): MergeResult {
  function skipped(owner: string, path: string) {
    return input.skip?.get(owner)?.has(path) ?? false;
  }
  const checked = check(schema, live, input.branches, (owner, path) => !skipped(owner, path));
  const unresolved = new Map<string, MergeResult["unresolved"][number]>();
  const resolutions = input.resolve ?? new Map();
  const published = new Map<string, string[]>();
  const pending = new Map<string, Change[]>();
  const typed = new Set<string>();
  // Applied outermost first, so an edit inside something another branch adds lands in it.
  const apply: Array<{ change: Change, branch: unknown }> = [];

  for(const branch of input.branches) {
    const changes = checked.get(branch.owner)!;
    published.set(branch.owner, []);
    pending.set(branch.owner, []);
    for(const change of changes) {
      if(skipped(branch.owner, change.path)) {
        pending.get(branch.owner)!.push(change);
        continue;
      }
      published.get(branch.owner)!.push(change.path);
      if(change.status === "live") continue;
      if(change.status === "clean") {
        apply.push({ change, branch: branch.data });
        continue;
      }
      const group = change.group!;
      const resolution = resolutions.get(group);
      if(!resolution) {
        const entry = unresolved.get(group) ?? { group, status: change.status, changes: [] };
        if(change.status === "conflict") entry.status = "conflict";
        entry.changes.push({ owner: branch.owner, change });
        unresolved.set(group, entry);
        continue;
      }
      if("value" in resolution) {
        if(!typed.has(group)) {
          typed.add(group);
          apply.push({ change: { ...change, kind: "set", segments: segmentsOf(change, group), after: resolution.value }, branch: branch.data });
        }
        continue;
      }
      if(resolution.use === branch.owner) apply.push({ change, branch: branch.data });
    }
  }
  let data = structuredClone(live ?? emptyLike(input.branches[0]?.data));
  apply.sort((a, b) => a.change.segments.length - b.change.segments.length);
  for(const { change, branch } of apply) data = applyChange(data, change, branch) ?? data;

  const rebased = new Map<string, unknown | null>();
  for(const branch of input.branches) rebased.set(branch.owner, rebase(data, pending.get(branch.owner)!, branch.data));
  return { data, unresolved: [...unresolved.values()], rebased, pending, published };
}

/** A branch's pending changes on top of a new live copy, or `null` when that leaves nothing to publish. */
export function rebase(live: unknown, changes: Change[], branch: unknown): unknown | null {
  let next = structuredClone(live);
  for(const change of changes) next = applyChange(next, change, branch) ?? next;
  return changes.length && !deepEqual(next, live) ? next : null;
}

/** The segments of a group path, taken from a change inside it. */
function segmentsOf(change: Change, group: string): Segment[] {
  for(let n = change.segments.length; n >= 0; n--) {
    const segments = change.segments.slice(0, n);
    if(pathString(segments) === group) return segments;
  }
  return change.segments;
}

// --- Keys ---------------------------------------------------------------------

/**
 * Keys for blocks saved before blocks had them, by position. Every copy of a document gets the same
 * ones, so an unchanged block matches across the live copy and the branches until it's saved with a real key.
 */
export function withPositionalKeys<T>(schema: AnySchema, value: T): T {
  assignKeys(schema, value, index => `pos${index}`);
  return value;
}

/**
 * Gives every item of a keyed list (blocks) a key it lacks, and a new one where two share a key (a
 * duplicated block). `newKey` gets the item's position. Mutates `value`; returns whether anything changed.
 */
export function assignKeys(schema: AnySchema, value: unknown, newKey: (index: number) => string): boolean {
  let changed = false;
  function visit(s: AnySchema, v: unknown) {
    const inner = unwrap(s);
    if(inner.type === "object" && isRecord(v)) {
      for(const [key, field] of Object.entries((inner as ObjectSchema).shape)) visit(field, v[key]);
    } else if(inner.type === "union" && isRecord(v)) {
      const option = optionFor(inner, v);
      if(option) visit(option, v);
    } else if(inner.type === "array" && Array.isArray(v)) {
      const item = (inner as ArraySchema).item;
      if(isKeyedList(inner)) {
        const seen = new Set<string>();
        for(const [index, entry] of v.entries()) {
          if(!isRecord(entry)) continue;
          const key = itemKey(entry);
          if(!key || seen.has(key)) {
            entry[ITEM_KEY] = newKey(index);
            changed = true;
          }
          seen.add(entry[ITEM_KEY] as string);
        }
      }
      for(const entry of v) visit(item, entry);
    }
  }
  visit(schema, value);
  return changed;
}
