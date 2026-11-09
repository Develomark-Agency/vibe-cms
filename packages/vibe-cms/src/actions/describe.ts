import { z } from "zod";
import type { ActionAnnotations, ActionEntry } from "./define.ts";
import { inputFields, isFileSchema, isZod, type ActionInput } from "./inputs.ts";

/** An action as `GET /_vibe/api/actions` lists it: name, title, description, annotations, input JSON Schema. */
export interface ActionDescription {
  name: string,
  title: string,
  description: string,
  annotations: ActionAnnotations,
  /** Whether agents get it as an MCP tool. */
  mcp: boolean,
  /** The plugin it comes from, if any. */
  plugin?: string,
  input: Record<string, unknown>
}

/** A file sent inside JSON, where bytes can't go as they are. */
export interface JsonFile {
  name: string,
  type?: string,
  base64: string
}

/** How `z.file()` describes itself; `fileInput()` (a `z.instanceof`) is given the same. */
const binaryFileSchema = { type: "string", format: "binary", contentEncoding: "binary" };

const jsonFileSchema = {
  type: "object",
  description: "A file, its content base64-encoded",
  properties: {
    name: { type: "string", description: "File name with extension, e.g. cover.jpg" },
    type: { type: "string", description: "MIME type; guessed from the name when omitted" },
    base64: { type: "string", contentEncoding: "base64" }
  },
  required: ["name", "base64"],
  additionalProperties: false
};

/**
 * An action's input as JSON Schema. Zod inputs (the built-in actions') can describe file fields:
 * `files: "json"` gives them as {@link JsonFile} objects, for surfaces that only carry JSON (MCP).
 * Any other input describes itself through Standard JSON Schema.
 */
export function inputJsonSchema(schema: ActionInput, options: { files?: "binary" | "json" } = {}): Record<string, unknown> {
  if(!isZod(schema)) {
    const convert = schema["~standard"].jsonSchema?.input;
    if(typeof convert !== "function") throw new Error("the input schema doesn't implement Standard JSON Schema (`~standard.jsonSchema`), so it can't be described to agents");
    return convert({ target: "draft-2020-12" });
  }
  return z.toJSONSchema(schema, {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
    override: ctx => {
      if(!isFileSchema(ctx.zodSchema)) return;
      for(const key of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[key];
      Object.assign(ctx.jsonSchema, options.files === "json" ? jsonFileSchema : binaryFileSchema);
    }
  }) as Record<string, unknown>;
}

/** Every action's description, for listings and generated clients. */
export function describeActions(actions: ActionEntry[], options: { files?: "binary" | "json" } = {}): ActionDescription[] {
  return actions.map(action => ({
    name: action.name,
    title: action.title,
    description: action.description,
    annotations: action.annotations,
    mcp: action.mcp,
    ...(action.plugin ? { plugin: action.plugin } : {}),
    input: inputJsonSchema(action.input, options)
  }));
}

/** Turns {@link JsonFile} values back into `File`s before the input is validated. Only built-in (zod) inputs have file fields. */
export function filesFromJson(schema: ActionInput, input: unknown): unknown {
  if(typeof input !== "object" || input === null) return input;
  const out: Record<string, unknown> = { ...input };
  for(const [key, info] of inputFields(schema)) {
    const value = out[key] as Partial<JsonFile> | undefined;
    if(info.kind !== "file" || typeof value !== "object" || value === null || typeof value.base64 !== "string") continue;
    const bytes = Uint8Array.from(atob(value.base64), char => char.charCodeAt(0));
    out[key] = new File([bytes], value.name ?? "upload", { type: value.type ?? "" });
  }
  return out;
}
