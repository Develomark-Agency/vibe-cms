import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";

/**
 * What an action takes: any schema library that implements Standard Schema (to validate) and Standard
 * JSON Schema (to describe the input to agents and listings), such as zod 4.
 */
export type ActionInput = StandardSchemaV1 & StandardJSONSchemaV1;

/** Whether a schema is zod's. The text surfaces below (CLI flags, query strings, forms) read zod's internals, so they only know zod inputs. */
export function isZod(schema: ActionInput): schema is ActionInput & z.ZodType {
  return typeof schema === "object" && schema !== null && "_zod" in schema;
}

/** How a surface that only has text (query strings, form fields, CLI flags) should read a field. */
export type FieldKind = "string" | "number" | "boolean" | "strings" | "file" | "json";

export interface FieldInfo {
  kind: FieldKind,
  optional: boolean,
  nullable: boolean,
  description: string | undefined
}

const fileInputs = new WeakSet<z.core.$ZodType>();

/**
 * An uploaded file in an action's input. Prefer it to `z.file()`: zod types `z.file()` through
 * `typeof globalThis`, which doesn't see the Workers runtime's `File` class, so without the DOM lib its
 * value is typed only `{ type, size }`. This is typed from the `File` class itself, and is still
 * described and parsed as a file everywhere (`z.file()` is too).
 */
export function fileInput(): z.ZodType<File> {
  const schema = z.instanceof(File);
  fileInputs.add(schema);
  return schema;
}

/** A `fileInput()` or `z.file()` schema, unwrapped. */
export function isFileSchema(schema: z.core.$ZodType): boolean {
  return fileInputs.has(schema) || schema._zod.def.type === "file";
}

type Def = { type: string, innerType?: z.ZodType, element?: z.ZodType, values?: unknown[] };

function def(schema: z.ZodType): Def {
  return (schema as unknown as { _zod: { def: Def } })._zod.def;
}

/** Peels off optional, nullable and default to find what a field holds. */
export function fieldInfo(schema: z.ZodType): FieldInfo {
  let current = schema;
  let optional = false;
  let nullable = false;
  let description = schema.description;
  for(;;) {
    const d = def(current);
    if(d.type === "optional" || d.type === "default") optional = true;
    else if(d.type === "nullable") nullable = true;
    else break;
    current = d.innerType!;
    description ??= current.description;
  }
  const d = def(current);
  const kind: FieldKind = d.type === "string" || d.type === "enum" || (d.type === "literal" && typeof d.values?.[0] === "string") ? "string"
    : d.type === "number" ? "number"
      : d.type === "boolean" ? "boolean"
        : isFileSchema(current) ? "file"
          : d.type === "array" && fieldInfo(d.element!).kind === "string" ? "strings"
            : "json";
  return { kind, optional, nullable, description };
}

/** The fields of an action's input object. None for inputs that aren't zod: the text surfaces can't read them. */
export function inputFields(schema: ActionInput): Array<[string, FieldInfo]> {
  if(!isZod(schema)) return [];
  const shape = (schema as unknown as { shape?: Record<string, z.ZodType> }).shape ?? {};
  return Object.entries(shape).map(([key, field]) => [key, fieldInfo(field)]);
}

/**
 * Turns text values into the types an action's input expects. Values that don't
 * convert are passed through as they are, for the input's validation to report.
 */
export function fromText(schema: ActionInput, values: Record<string, string | string[] | File | undefined>): Record<string, unknown> {
  // Not zod: nothing says what its fields are, so the values go in as they came, for its own validation.
  if(!isZod(schema)) return { ...values };
  const out: Record<string, unknown> = {};
  for(const [key, info] of inputFields(schema)) {
    const raw = values[key];
    if(raw === undefined) continue;
    if(raw instanceof File) {
      out[key] = raw;
      continue;
    }
    if(info.kind === "strings") {
      out[key] = Array.isArray(raw) ? raw : [raw];
      continue;
    }
    const value = Array.isArray(raw) ? raw[raw.length - 1]! : raw;
    if(info.nullable && value === "null") {
      out[key] = null;
      continue;
    }
    switch(info.kind) {
      case "string":
        out[key] = value;
        break;
      case "number":
        if(value !== "") out[key] = Number.isNaN(Number(value)) ? value : Number(value);
        break;
      case "boolean":
        out[key] = value === "" || value === "1" || value === "true" ? true : value === "0" || value === "false" ? false : value;
        break;
      default:
        if(value === "") break;
        try {
          out[key] = JSON.parse(value);
        } catch {
          out[key] = value;
        }
    }
  }
  return out;
}
