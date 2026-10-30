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

export function text(options: TextOptions = {}): TextSchema {
  return withStandard({ kind: "field", type: "text", ...options });
}

export function number(options: NumberOptions = {}): NumberSchema {
  return withStandard({ kind: "field", type: "number", ...options });
}

export function boolean(options: BooleanOptions = {}): BooleanSchema {
  return withStandard({ kind: "field", type: "boolean", ...options });
}

export function date(options: DateOptions = {}): DateSchema {
  return withStandard({ kind: "field", type: "date", ...options });
}

export function literal<const V extends Primitive>(value: V, options: FieldOptions<V> = {}): LiteralSchema<V> {
  return withStandard({ kind: "field", type: "literal", value, ...options });
}

// `enum` is reserved, so the builder is exported under that name below.
function enumeration<const V extends string>(values: readonly V[], options: EnumOptions<V> = {}): EnumSchema<V> {
  return withStandard({ kind: "field", type: "enum", values, ...options });
}

export { enumeration as enum };

export function optional<S extends AnySchema>(inner: S): OptionalSchema<S> {
  return withStandard({ kind: "field", type: "optional", inner });
}

export function array<S extends AnySchema>(item: S, options: ArrayOptions<Input<S>> = {}): ArraySchema<S> {
  return withStandard({ kind: "field", type: "array", item, ...options });
}

export function object<S extends Shape>(shape: S, options: FieldOptions<Input<ObjectSchema<S>>> = {}): ObjectSchema<S> {
  return withStandard({ kind: "field", type: "object", shape, ...options });
}

export function union<const S extends readonly AnySchema[]>(
  options: S,
  fieldOptions: FieldOptions<Input<S[number]>> = {}
): UnionSchema<S> {
  return withStandard({ kind: "field", type: "union", options, ...fieldOptions });
}

/** A reference to a document of type `to`, or to any document when omitted. */
export function ref<const To extends string | undefined = undefined>(to?: To, options: RefOptions = {}): RefSchema<To> {
  return withStandard<RefSchema<To>>({ kind: "field", type: "ref", ...(to === undefined ? {} : { to }), ...options } as Omit<RefSchema<To>, "~standard">);
}

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

export function parseSize(size: string | number): number {
  if(typeof size === "number") return size;
  const match = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(size);
  const unit = units[(match?.[2] || "b").toLowerCase()];
  if(!match || unit === undefined) throw new Error(`vibe-cms: invalid size "${size}"`);
  return Math.round(Number(match[1]) * unit);
}

export type Schema = AnySchema;

export function isSchema(value: unknown): value is AnySchema {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "field";
}

export function unwrapOptional(schema: AnySchema): AnySchema {
  return schema.type === "optional" ? (schema as OptionalSchema).inner : schema;
}
