import type {
  AnySchema,
  ArrayOptions,
  ArraySchema,
  AssetOptions,
  AssetSchema,
  BooleanOptions,
  BooleanSchema,
  DateOptions,
  DateSchema,
  EnumOptions,
  EnumSchema,
  FieldOptions,
  Input,
  LiteralSchema,
  NumberOptions,
  NumberSchema,
  ObjectSchema,
  OptionalSchema,
  Output,
  Primitive,
  RefOptions,
  RefSchema,
  Shape,
  TextOptions,
  TextSchema,
  UnionSchema
} from "./types.ts";
import type { CollectionMarker } from "../config.ts";
import { withStandard } from "./standard.ts";

export type * from "./types.ts";

/** The stored shape of a schema (or collection), as written by editors and the API. */
export type Infer<S> = S extends CollectionMarker<any, infer O> ? Input<O> : Input<S>;
/** The shape returned by queries: assets resolved to records with URLs. */
export type InferOutput<S> = S extends CollectionMarker<any, infer O> ? Output<O> : Output<S>;

/** A string. `format` checks emails, URLs, slugs or site paths; `unique` (top-level only) is per type and locale. */
export function text(options: TextOptions = {}): TextSchema {
  return withStandard({ kind: "field", type: "text", ...options });
}

/** A number. `integer` refuses fractions; `step` is the editor's increment. */
export function number(options: NumberOptions = {}): NumberSchema {
  return withStandard({ kind: "field", type: "number", ...options });
}

/** True or false: a switch in the editor. */
export function boolean(options: BooleanOptions = {}): BooleanSchema {
  return withStandard({ kind: "field", type: "boolean", ...options });
}

/** An ISO 8601 string: a date, or a date and time with `time: true`. Queries compare it as a string, and accept `Date`. */
export function date(options: DateOptions = {}): DateSchema {
  return withStandard({ kind: "field", type: "date", ...options });
}

/** Exactly one value. Mostly the discriminant of a union member: `kind: v.literal("link")`. */
export function literal<const V extends Primitive>(value: V, options: FieldOptions<V> = {}): LiteralSchema<V> {
  return withStandard({ kind: "field", type: "literal", value, ...options });
}

// `enum` is reserved, so the builder is exported under that name below.
/** One of a fixed set of strings, exported as `v.enum`. `labels` sets what the editor shows. */
function enumeration<const V extends string>(values: readonly V[], options: EnumOptions<V> = {}): EnumSchema<V> {
  return withStandard({ kind: "field", type: "enum", values, ...options });
}

export { enumeration as enum };

/** Makes a field optional. Fields are required otherwise (an empty array satisfies a required array). */
export function optional<S extends AnySchema>(inner: S): OptionalSchema<S> {
  return withStandard({ kind: "field", type: "optional", inner });
}

/** A list of `item`. `min`/`max` count items. */
export function array<S extends AnySchema>(item: S, options: ArrayOptions<Input<S>> = {}): ArraySchema<S> {
  return withStandard({ kind: "field", type: "array", item, ...options });
}

/**
 * Fields grouped under one key, and the root of every content type. Keys it doesn't declare
 * are dropped on write. See `vibe-cms docs schemas`.
 */
export function object<S extends Shape>(shape: S, options: FieldOptions<Input<ObjectSchema<S>>> = {}): ObjectSchema<S> {
  return withStandard({ kind: "field", type: "object", shape, ...options });
}

/**
 * One of several schemas. For objects, give each a `v.literal` discriminant so values (and
 * TypeScript types) can be told apart; the editor shows a type picker.
 */
export function union<const S extends readonly AnySchema[]>(
  options: S,
  fieldOptions: FieldOptions<Input<S[number]>> = {}
): UnionSchema<S> {
  return withStandard({ kind: "field", type: "union", options, ...fieldOptions });
}

/**
 * A reference to a document of type `to` (stores its ID), or to any document when omitted
 * (stores `{ type, id }`). Writes check the target exists; queries expand it with `with`.
 * See `vibe-cms docs references`.
 */
export function ref<const To extends string | undefined = undefined>(to?: To, options: RefOptions = {}): RefSchema<To> {
  return withStandard<RefSchema<To>>({ kind: "field", type: "ref", ...(to === undefined ? {} : { to }), ...options } as Omit<RefSchema<To>, "~standard">);
}

/**
 * A media library file plus per-usage `fields` (stores `{ asset, …fields }`, never a URL). Queries
 * add `url`, `mime`, `size` and dimensions. The presets in `vibe-cms/media` build on it.
 * See `vibe-cms docs media`.
 */
export function asset<F extends Shape = {}>(options: AssetOptions<F> = {}): AssetSchema<F> {
  const { maxSize, fields, ...rest } = options;
  return withStandard<AssetSchema<F>>({
    kind: "field",
    type: "asset",
    ...rest,
    ...(maxSize === undefined ? {} : { maxSize: parseSize(maxSize) }),
    fields: (fields ?? {}) as F
  });
}

const units: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };

/** `"5MB"` → 5000000. Decimal (`kb`, `mb`, `gb`) and binary (`kib`, `mib`, `gib`) units. */
export function parseSize(size: string | number): number {
  if(typeof size === "number") return size;
  const match = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(size);
  const unit = units[(match?.[2] || "b").toLowerCase()];
  if(!match || unit === undefined) throw new Error(`vibe-cms: invalid size "${size}"`);
  return Math.round(Number(match[1]) * unit);
}

/** Any field schema. */
export type Schema = AnySchema;

/** Whether a value is a field schema built with `v`. */
export function isSchema(value: unknown): value is AnySchema {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "field";
}

/** The schema inside `v.optional`, or the schema itself. */
export function unwrapOptional(schema: AnySchema): AnySchema {
  return schema.type === "optional" ? (schema as OptionalSchema).inner : schema;
}
