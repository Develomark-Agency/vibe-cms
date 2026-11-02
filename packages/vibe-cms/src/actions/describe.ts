import { z } from "zod";
import type { ActionAnnotations, AnyAction } from "./define.ts";
import { inputFields } from "./inputs.ts";

/** An action as `GET /_vibe/api/actions` lists it: name, title, description, annotations, input JSON Schema. */
export interface ActionDescription {
  name: string,
  title: string,
  description: string,
  annotations: ActionAnnotations,
  input: Record<string, unknown>
}

/** A file sent inside JSON, where bytes can't go as they are. */
export interface JsonFile {
  name: string,
  type?: string,
  base64: string
}

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
 * An action's input as JSON Schema. `files: "json"` describes file fields as
 * {@link JsonFile} objects, for surfaces that only carry JSON (MCP).
 */
export function inputJsonSchema(action: AnyAction, options: { files?: "binary" | "json" } = {}): Record<string, unknown> {
  return z.toJSONSchema(action.input, {
    io: "input",
    target: "draft-2020-12",
    unrepresentable: "any",
    override: ctx => {
      const type = (ctx.zodSchema as unknown as { _zod: { def: { type: string } } })._zod.def.type;
      if(type === "file" && options.files === "json") {
        for(const key of Object.keys(ctx.jsonSchema)) delete (ctx.jsonSchema as Record<string, unknown>)[key];
        Object.assign(ctx.jsonSchema, jsonFileSchema);
      }
    }
  }) as Record<string, unknown>;
}

/** Every action's description, for listings and generated clients. */
export function describeActions(actions: Record<string, AnyAction>, options: { files?: "binary" | "json" } = {}): ActionDescription[] {
  return Object.values(actions).map(action => ({
    name: action.name,
    title: action.title,
    description: action.description,
    annotations: action.annotations,
    input: inputJsonSchema(action, options)
  }));
}

/** Turns {@link JsonFile} values back into `File`s before the input is validated. */
export function filesFromJson(action: AnyAction, input: unknown): unknown {
  if(typeof input !== "object" || input === null) return input;
  const out: Record<string, unknown> = { ...input };
  for(const [key, info] of inputFields(action.input)) {
    const value = out[key] as Partial<JsonFile> | undefined;
    if(info.kind !== "file" || typeof value !== "object" || value === null || typeof value.base64 !== "string") continue;
    const bytes = Uint8Array.from(atob(value.base64), char => char.charCodeAt(0));
    out[key] = new File([bytes], value.name ?? "upload", { type: value.type ?? "" });
  }
  return out;
}
