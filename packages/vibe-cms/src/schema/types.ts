import type { WidgetDescriptor } from "../descriptor.ts";

/** Phantom carrier for a schema's stored (input) and query result (output) types. */
export interface Types<I, O = I> {
  input: I,
  output: O
}

export interface BaseSchema<I = unknown, O = I> {
  kind: "field",
  type: string,
  label?: string,
  description?: string,
  widget?: WidgetDescriptor<any, any>,
  readonly "~types"?: Types<I, O>
}

export type AnySchema = BaseSchema<any, any>;

/** Options every field accepts. The widget must edit this field's value type. */
export interface FieldOptions<T> {
  label?: string,
  description?: string,
  widget?: WidgetDescriptor<T, any>
}

export interface TextOptions extends FieldOptions<string> {
  min?: number,
  max?: number,
  format?: "email" | "url" | "slug",
  pattern?: string,
  multiline?: boolean,
  indexed?: boolean
}

export interface TextSchema extends BaseSchema<string>, Omit<TextOptions, "widget" | "label" | "description"> {
  type: "text"
}

export interface NumberOptions extends FieldOptions<number> {
  min?: number,
  max?: number,
  integer?: boolean,
  step?: number,
  indexed?: boolean
}

export interface NumberSchema extends BaseSchema<number>, Omit<NumberOptions, "widget" | "label" | "description"> {
  type: "number"
}

export interface BooleanOptions extends FieldOptions<boolean> {
  indexed?: boolean
}

export interface BooleanSchema extends BaseSchema<boolean> {
  type: "boolean",
  indexed?: boolean
}

export interface DateOptions extends FieldOptions<string> {
  /** Include a time of day. Values are ISO 8601 strings either way. */
  time?: boolean,
  indexed?: boolean
}

export interface DateSchema extends BaseSchema<string> {
  type: "date",
  time?: boolean,
  indexed?: boolean
}

export type Primitive = string | number | boolean | null;

export interface LiteralSchema<V extends Primitive = Primitive> extends BaseSchema<V> {
  type: "literal",
  value: V
}

export interface EnumOptions<V extends string> extends FieldOptions<V> {
  /** Display labels per value. */
  labels?: Partial<Record<V, string>>,
  indexed?: boolean
}

export interface EnumSchema<V extends string = string> extends BaseSchema<V> {
  type: "enum",
  values: readonly V[],
  labels?: Partial<Record<V, string>>,
  indexed?: boolean
}

export interface OptionalSchema<S extends AnySchema = AnySchema>
  extends BaseSchema<Input<S> | undefined, Output<S> | undefined> {
  type: "optional",
  inner: S
}

export interface ArrayOptions<T> extends FieldOptions<T[]> {
  min?: number,
  max?: number
}

export interface ArraySchema<S extends AnySchema = AnySchema> extends BaseSchema<Array<Input<S>>, Array<Output<S>>> {
  type: "array",
  item: S,
  min?: number,
  max?: number
}

export type Shape = Record<string, AnySchema>;

export interface ObjectSchema<S extends Shape = Shape> extends BaseSchema<ShapeInput<S>, ShapeOutput<S>> {
  type: "object",
  shape: S
}

export interface UnionSchema<S extends readonly AnySchema[] = readonly AnySchema[]>
  extends BaseSchema<Input<S[number]>, Output<S[number]>> {
  type: "union",
  options: S
}

/** A reference to another document. Targeted refs store the ID, untargeted ones `{ type, id }`. */
export type RefValue<To extends string | undefined> = To extends string ? string : { type: string, id: string };

export interface RefOptions extends FieldOptions<any> {
  indexed?: boolean
}

export interface RefSchema<To extends string | undefined = string | undefined> extends BaseSchema<RefValue<To>> {
  type: "ref",
  to?: To,
  indexed?: boolean
}

export interface AssetMeta {
  width?: number,
  height?: number,
  duration?: number,
  [key: string]: unknown
}

/** An asset record merged into a query result. */
export interface ResolvedAsset {
  asset: string,
  url: string,
  mime: string,
  size: number,
  filename: string,
  width?: number,
  height?: number,
  duration?: number,
  meta: AssetMeta
}

export interface AssetOptions<F extends Shape = {}> extends FieldOptions<any> {
  /** Accepted MIME types, wildcards allowed (`image/*`). */
  accept?: string[],
  /** e.g. `"5MB"`, or bytes. */
  maxSize?: string | number,
  /** Default media library folder for uploads. Never part of the storage key. */
  folder?: string,
  /** Server-side check against extracted metadata. Return `true` or an error message. */
  validate?: (meta: AssetMeta & { mime: string, size: number }) => true | string | false,
  /** Per-usage data stored in the document, like alt text. */
  fields?: F
}

export interface AssetSchema<F extends Shape = Shape>
  extends BaseSchema<Simplify<{ asset: string } & ShapeInput<F>>, Simplify<ResolvedAsset & ShapeOutput<F>>> {
  type: "asset",
  accept?: string[],
  maxSize?: number,
  folder?: string,
  fields: F,
  validate?: AssetOptions["validate"]
}

export type Input<S> = S extends { readonly "~types"?: Types<infer I, any> } ? I : never;
export type Output<S> = S extends { readonly "~types"?: Types<any, infer O> } ? O : never;

export type Simplify<T> = { [K in keyof T]: T[K] } & {};

type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends OptionalSchema<any> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

export type ShapeInput<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Input<S[K]> } & { [K in OptionalKeys<S>]?: Input<S[K]> }
>;

export type ShapeOutput<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Output<S[K]> } & { [K in OptionalKeys<S>]?: Output<S[K]> }
>;
