import { z } from "zod";
import { getSchema } from "../../config.ts";
import { base, router } from "../define.ts";
import { type } from "./fields.ts";

const schemaList = base({
  summary: "List content types",
  description: "The site's content types and languages. Call `schema.get` for a type's fields before writing documents.",
  readOnly: true
})
  .handler(({ context: { engine } }) => {
    const { config } = engine;
    return {
      locales: config.locales,
      defaultLocale: config.defaultLocale,
      types: Object.keys(config.schemas).map(name => {
        const settings = config.collections?.[name];
        return { type: name, label: settings?.label ?? null, singleton: settings?.singleton ?? false };
      })
    };
  });

const schemaGet = base({
  summary: "Get a content type's fields",
  description: "JSON Schema for one content type's documents: the shape `data` must have when creating or updating them.",
  readOnly: true
})
  .input(z.object({ type }))
  .handler(async ({ context: { engine }, input }) => {
    getSchema(engine.config, input.type);
    return engine.config.schemas[input.type]!["~standard"].jsonSchema.input({ target: "draft-2020-12" });
  });

export const schema = router({
  list: schemaList,
  get: schemaGet
});
