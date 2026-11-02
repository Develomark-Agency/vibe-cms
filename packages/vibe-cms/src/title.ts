import type { AnyConfig, Collection } from "./config.ts";
import type { AnySchema, OptionalSchema } from "./schema/types.ts";

function unwrap(schema: AnySchema): AnySchema {
  return schema.type === "optional" ? (schema as OptionalSchema).inner : schema;
}

/** The field shown as a document's title: configured, or the first text field. Shared by the editor and the search index. */
export function titleField(config: AnyConfig, type: string): string | undefined {
  const collection = (config.schemas as Record<string, Collection | undefined>)[type];
  if(!collection) throw new Error(`Unknown content type "${type}"`);
  const configured = config.collections?.[type]?.title;
  if(configured) return configured as string;
  const shape = collection["~collection"].schema.shape;
  for(const preferred of ["title", "name", "label", "heading"]) {
    if(shape[preferred] && unwrap(shape[preferred] as AnySchema).type === "text") return preferred;
  }
  return Object.entries(shape).find(([, schema]) => unwrap(schema as AnySchema).type === "text")?.[0];
}
