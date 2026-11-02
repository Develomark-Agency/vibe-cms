/**
 * Marks for the editor's picker: `data-vibe-field={field(post, "title")}` says an element shows a
 * field, so clicking it in the draft preview opens that field. Outside preview it's `undefined`, which
 * Astro and React leave out, so the live site's HTML doesn't change. No node APIs: safe in browser
 * bundles, where it's always `undefined`. See `vibe-cms docs preview`.
 */

type Path = Array<string | number>;

/** Where a value in a query result lives, as the handler records it (`PickSource`). */
interface Source {
  type: string,
  id: string,
  locale: string,
  path: Path
}

function sources(): WeakMap<object, Source> | undefined {
  const store = (globalThis as { [key: symbol]: { getStore(): unknown } | undefined })[Symbol.for("vibe-cms.preview")];
  return (store?.getStore() as { sources?: WeakMap<object, Source> } | undefined)?.sources;
}

type Key<V> = V extends readonly unknown[] ? number : Exclude<keyof V, symbol | "$meta">;
type At<V, K> = V extends ReadonlyArray<infer I> ? I : K extends keyof V ? V[K] : never;
type Deeper = [never, 0, 1, 2, 3, 4, 5, 6];

/**
 * The paths into a value, as arguments: `"faq"`, `"faq", 2`, `"faq", 2, "answer"`. Any prefix is a path
 * too (marking a whole list or item). Six levels deep at most, which keeps large schemas fast to check.
 */
export type FieldPath<T, D extends number = 6> = [D] extends [never]
  ? []
  : NonNullable<T> extends infer V
    ? V extends object ? [] | { [K in Key<V>]-?: [K, ...FieldPath<At<V, K>, Deeper[D]>] }[Key<V>] : []
    : never;

/** `field()` bound to one item of a list: the rest of the path, from the item. */
export type FieldOf<I> = (...path: FieldPath<I>) => string | undefined;

export interface Field {
  /**
   * The `data-vibe-field` value for an element showing `value` (or a field in it, by path). `value`
   * must be an object (or array) straight from `vibe.client(env)`, not a copy: copies, and anything
   * outside preview, give `undefined`, and the picker then works out what it can by itself.
   */
  <T extends object>(value: T | null | undefined, ...path: FieldPath<T>): string | undefined,
  /**
   * A list's items with `field()` bound to each, by their position in the document. Filter and sort
   * the pairs as you like: each keeps its own position.
   *
   * ```astro
   * {field.entries(post.faq).filter(([item]) => item.featured).map(([item, attr]) => (
   *   <p data-vibe-field={attr("answer")}>{item.answer}</p>
   * ))}
   * ```
   */
  entries<I>(list: readonly I[] | null | undefined): Array<[item: I, attr: FieldOf<I>, index: number]>,
  /**
   * For HTML built as strings: ` data-vibe-field="…"`, escaped, with its leading space, or `""` where
   * `field()` would be `undefined`. `` `<h1${field.attribute(post, "title")}>` ``
   */
  attribute<T extends object>(value: T | null | undefined, ...path: FieldPath<T>): string
}

function encode(source: Source, path: Path): string {
  return JSON.stringify({ type: source.type, id: source.id, locale: source.locale, path: [...source.path, ...path] });
}

function mark(value: unknown, path: Path): string | undefined {
  if(typeof value !== "object" || value === null) return undefined;
  const source = sources()?.get(value);
  return source ? encode(source, path) : undefined;
}

export const field: Field = Object.assign(
  (value: object | null | undefined, ...path: Path) => mark(value, path),
  {
    attribute(value: object | null | undefined, ...path: Path): string {
      const marked = mark(value, path);
      return marked === undefined ? "" : ` data-vibe-field="${marked.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"`;
    },
    entries<I>(list: readonly I[] | null | undefined): Array<[I, FieldOf<I>, number]> {
      const source = list ? sources()?.get(list) : undefined;
      return (list ?? []).map((item, index): [I, FieldOf<I>, number] => [
        item,
        // The list's own source, else the item's: a list rebuilt from a query's items still has them.
        ((...path: Path) => (source ? encode(source, [index, ...path]) : mark(item, path))) as FieldOf<I>,
        index
      ]);
    }
  }
);
