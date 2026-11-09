import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * The TUI's forms: fields read from an action's input JSON Schema (as `GET /_vibe/api/actions` lists it,
 * so plugins' actions get forms too), and the values typed into them turned back into the action's input.
 */

export type FieldKind = "string" | "enum" | "number" | "boolean" | "strings" | "file" | "json";

export interface Field {
  key: string,
  /** What the form shows: the key, or a label of its own for commands' forms. */
  label?: string,
  kind: FieldKind,
  required: boolean,
  nullable?: boolean,
  description?: string,
  /** An enum's values. */
  options?: string[],
  /** Shown greyed out when the field is empty. */
  placeholder?: string
}

/** What a form holds: text for most fields, true/false (or unset) for booleans. */
export type FormValues = Record<string, string | boolean | undefined>;

type JsonSchema = {
  type?: string | string[],
  enum?: unknown[],
  const?: unknown,
  format?: string,
  items?: JsonSchema,
  anyOf?: JsonSchema[],
  oneOf?: JsonSchema[],
  properties?: Record<string, JsonSchema>,
  required?: string[],
  description?: string,
  default?: unknown,
  minimum?: number,
  maximum?: number
};

/** One schema out of `anyOf: [X, { type: "null" }]` or `type: ["string", "null"]`, and whether null was allowed. */
function unwrapNull(schema: JsonSchema): { schema: JsonSchema, nullable: boolean } {
  const variants = schema.anyOf ?? schema.oneOf;
  if(variants) {
    const rest = variants.filter(v => v.type !== "null");
    const nullable = rest.length < variants.length;
    if(rest.length === 1) return { schema: { ...rest[0], description: schema.description ?? rest[0]!.description, default: schema.default ?? rest[0]!.default }, nullable };
    return { schema: { description: schema.description, default: schema.default }, nullable };
  }
  if(Array.isArray(schema.type)) {
    const rest = schema.type.filter(t => t !== "null");
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : undefined }, nullable: rest.length < schema.type.length };
  }
  return { schema, nullable: false };
}

function kindOf(schema: JsonSchema): Pick<Field, "kind" | "options"> {
  if(schema.enum?.every(value => typeof value === "string")) return { kind: "enum", options: schema.enum as string[] };
  if(typeof schema.const === "string") return { kind: "enum", options: [schema.const] };
  if(schema.type === "string" && schema.format === "binary") return { kind: "file" };
  if(schema.type === "string") return { kind: "string" };
  if(schema.type === "number" || schema.type === "integer") return { kind: "number" };
  if(schema.type === "boolean") return { kind: "boolean" };
  if(schema.type === "array" && schema.items?.type === "string") return { kind: "strings" };
  return { kind: "json" };
}

function placeholderOf(schema: JsonSchema, kind: FieldKind): string | undefined {
  if(schema.default !== undefined) return `default: ${JSON.stringify(schema.default)}`;
  if(kind === "json") return "JSON, or @file.json";
  if(kind === "file") return "path to a file";
  if(kind === "strings") return "comma, separated";
  if(kind === "number" && schema.minimum !== undefined && schema.maximum !== undefined && schema.maximum < 1e9) return `${schema.minimum}–${schema.maximum}`;
  return undefined;
}

/** The fields of an action's input: one per property of its top-level object. */
export function fieldsFromSchema(input: Record<string, unknown>): Field[] {
  const schema = input as JsonSchema;
  if(!schema.properties) return schema.type === "object" ? [] : [{ key: "input", kind: "json", required: false, description: "The whole input, as JSON", placeholder: "JSON, or @file.json" }];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([key, raw]) => {
    const { schema: field, nullable } = unwrapNull(raw);
    const { kind, options } = kindOf(field);
    return {
      key,
      kind,
      options,
      required: required.has(key),
      nullable,
      description: field.description,
      placeholder: placeholderOf(field, kind)
    };
  });
}

/** `~/x` → the home folder's `x`; relative paths are against the current directory. */
export function resolvePath(value: string): string {
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(expanded);
}

/** Problems with a form's values that are worth saying before anything is sent: missing fields and JSON that doesn't parse. */
export function checkValues(fields: Field[], values: FormValues): string | undefined {
  for(const field of fields) {
    const value = values[field.key];
    if(field.required && (value === undefined || value === "")) return `${field.label ?? field.key} is required`;
    if(field.kind === "json" && typeof value === "string" && value.trim() && !value.trim().startsWith("@")) {
      try {
        JSON.parse(value);
      } catch (error) {
        return `${field.label ?? field.key} isn't valid JSON: ${(error as Error).message}`;
      }
    }
  }
  return undefined;
}

/** A form's values as the action's input. Empty fields are left out, for the action's defaults. */
export async function toInput(fields: Field[], values: FormValues): Promise<Record<string, unknown>> {
  const problem = checkValues(fields, values);
  if(problem) throw new Error(problem);
  const out: Record<string, unknown> = {};
  for(const field of fields) {
    const value = values[field.key];
    if(value === undefined || value === "") continue;
    if(typeof value === "boolean") {
      out[field.key] = value;
      continue;
    }
    if(field.nullable && value === "null") {
      out[field.key] = null;
      continue;
    }
    switch(field.kind) {
      case "number":
        out[field.key] = Number.isNaN(Number(value)) ? value : Number(value);
        break;
      case "strings":
        out[field.key] = value.split(",").map(item => item.trim()).filter(Boolean);
        break;
      case "json": {
        const text = value.trim().startsWith("@") ? await readFile(resolvePath(value.trim().slice(1)), "utf8") : value;
        try {
          out[field.key] = JSON.parse(text);
        } catch (error) {
          throw new Error(`${field.label ?? field.key} isn't valid JSON: ${(error as Error).message}`);
        }
        break;
      }
      case "file": {
        const file = resolvePath(value);
        out[field.key] = new File([await readFile(file)], path.basename(file));
        break;
      }
      default:
        out[field.key] = value;
    }
  }
  if(fields.length === 1 && fields[0]!.key === "input" && fields[0]!.kind === "json") return (out.input ?? {}) as Record<string, unknown>;
  return out;
}

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
}

/** Quotes a shell argument only when it needs it. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The same thing as a `vibe-cms` command, to show what the TUI runs and teach the headless CLI. Built-in
 * actions have commands of their own; a plugin's goes through `vibe-cms action <name> --input`.
 */
export function actionCommandLine(action: { name: string, plugin?: string }, fields: Field[], values: FormValues, site?: { url: string, prefix: string }): string {
  const parts = ["vibe-cms"];
  if(action.plugin || !action.name.includes(".")) {
    parts.push("action", action.name);
    const input: Record<string, unknown> = {};
    for(const field of fields) {
      const value = values[field.key];
      if(value === undefined || value === "") continue;
      if(typeof value === "boolean" || field.kind !== "json") input[field.key] = field.kind === "number" && typeof value === "string" ? Number(value) : value;
      else {
        try {
          input[field.key] = JSON.parse(value);
        } catch {
          input[field.key] = value;
        }
      }
    }
    if(Object.keys(input).length) parts.push("--input", shellQuote(JSON.stringify(input)));
  } else {
    const [group, ...rest] = action.name.split(".");
    parts.push(group!, kebab(rest.join(".")));
    for(const field of fields) {
      const value = values[field.key];
      if(value === undefined || value === "" || value === false) continue;
      const flag = `--${kebab(field.key)}`;
      if(value === true) parts.push(flag);
      else if(field.kind === "strings") for(const item of value.split(",").map(s => s.trim()).filter(Boolean)) parts.push(flag, shellQuote(item));
      else parts.push(flag, shellQuote(value));
    }
  }
  if(site) {
    parts.push("--site", shellQuote(site.url));
    if(site.prefix !== "/_vibe") parts.push("--prefix", shellQuote(site.prefix));
  }
  return parts.join(" ");
}
