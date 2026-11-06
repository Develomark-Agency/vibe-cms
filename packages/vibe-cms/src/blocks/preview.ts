/**
 * Whether this render is an editor's draft preview. vibe-cms keeps the preview scope on a global
 * symbol, so this needs no import of the server package (and none of node's APIs in browser bundles).
 */
export function inPreview(): boolean {
  return scope() !== undefined;
}

type Path = Array<string | number>;

/** The document a value came from, as vibe-cms's `PickSource`. */
export interface PickSource {
  type: string,
  id: string,
  locale: string,
  path: Path
}

interface Scope {
  sources?: WeakMap<object, PickSource>,
  pick?: boolean
}

function scope(): Scope | undefined {
  const store = (globalThis as { [key: symbol]: { getStore(): unknown } | undefined })[Symbol.for("vibe-cms.preview")];
  return store?.getStore() as Scope | undefined;
}

/**
 * Whether this render is the editor's picker reading the page (a background request, never the page
 * on screen): `<Blocks>` then renders each block's variants, for the picker to tell where each field shows.
 */
export function inPickRender(): boolean {
  return scope()?.pick === true;
}

/** Which document (and field) a list of blocks came from, if it came straight from a query. */
export function pickSource(value: object): PickSource | null {
  return scope()?.sources?.get(value) ?? null;
}

/** Most variants a block gets; past this, fields are changed a list or an object at a time. */
const MOST = 30;
/** Discriminators, ids and metadata: changing them says nothing about where a field shows. */
const SKIP = new Set(["type", "kind", "id"]);

function leaves(value: unknown, path: Path, out: Path[]) {
  if(typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) out.push(path);
  else if(Array.isArray(value)) value.forEach((item, i) => leaves(item, [...path, i], out));
  else if(typeof value === "object" && value !== null) {
    for(const [key, item] of Object.entries(value)) {
      if(!SKIP.has(key) && !key.startsWith("$") && !key.startsWith("_")) leaves(item, [...path, key], out);
    }
  }
}

/** A different value of the same kind, kept recognisably different through truncation and case changes. */
function change(value: string | number): string | number {
  return typeof value === "number" ? value + 1 : `Ж${value}`;
}

function set(target: unknown, path: Path, value: unknown) {
  let node = target as Record<string | number, unknown>;
  for(const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  node[path.at(-1)!] = value;
}

function get(target: unknown, path: Path): unknown {
  return path.reduce<unknown>((node, key) => (node as Record<string | number, unknown>)[key], target);
}

/**
 * Copies of a block, each with one field (or, for large blocks, one list or object) changed. The picker
 * renders them beside the block and compares: whatever changes shows that field, however the
 * component transforms it.
 */
export function pickVariants<B extends object>(block: B): Array<{ path: Path, block: B }> {
  const all: Path[] = [];
  leaves(block, [], all);
  let groups = all;
  if(all.length > MOST) {
    const deepest = Math.max(...all.map(path => path.length));
    groups = [];
    for(let depth = deepest - 1; depth >= 1; depth--) {
      const prefixes = [...new Map(all.map(path => [JSON.stringify(path.slice(0, depth)), path.slice(0, depth)])).values()];
      groups = prefixes;
      if(prefixes.length <= MOST) break;
    }
    groups = groups.slice(0, MOST);
  }
  return groups.map(group => {
    const copy = structuredClone(block);
    for(const path of all) {
      if(group.every((key, i) => key === path[i])) set(copy, path, change(get(block, path) as string | number));
    }
    return { path: group, block: copy };
  });
}
