import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec";
import { z } from "zod";
import { defineAction, defineServer } from "../src/server/index.ts";
import { calls, type AuditPlugin, type config } from "./fixture.ts";

const shoutInput = {
  "~standard": {
    version: 1,
    vendor: "test",
    // Only for the types: what a library's schema says it parses.
    types: undefined as unknown as { input: { word: string }, output: { word: string } },
    validate: (value: unknown) => typeof value === "object" && value !== null && typeof (value as { word?: unknown }).word === "string"
      ? { value: value as { word: string } }
      : { issues: [{ message: "word: expected a string", path: ["word"] }] },
    jsonSchema: {
      input: () => ({ type: "object", properties: { word: { type: "string" } }, required: ["word"] }),
      output: () => ({ type: "object", properties: { word: { type: "string" } }, required: ["word"] })
    }
  }
} satisfies StandardSchemaV1<{ word: string }> & StandardJSONSchemaV1<{ word: string }>;

export default defineServer<typeof AuditPlugin, typeof config>(async ({ options }) => ({
  "content.beforeWrite": async (input, output) => {
    calls.push(`beforeWrite:${input.type}:${input.action}`);
    // Narrowing on the output narrows the document: `title` is a typed string here.
    if(output.type === "post" && output.valid) output.doc.searchText = `${options.tag}:${output.doc.title.toLowerCase()}`;
  },
  "content.afterWrite": async ({ type, action }) => {
    calls.push(`afterWrite:${type}:${action}`);
  },
  "content.beforeDelete": async ({ id }, output) => {
    if(id === "protected") output.cancel = "This one is protected";
  },
  instructions: "Use echo to check the connection.",
  actions: {
    echo: defineAction({
      summary: "Echo",
      description: "Returns what it's given, tagged with the plugin's option.",
      readOnly: true,
      mcp: true,
      input: z.object({ text: z.string() }),
      handler: ({ input }) => ({ text: input.text, tag: options.tag })
    }),
    touch: defineAction({
      summary: "Touch",
      description: "Records a call. Not offered to agents.",
      handler: () => {
        calls.push("touch");
        return { touched: true };
      }
    }),
    // A schema from a library that isn't zod: only Standard Schema and Standard JSON Schema.
    shout: defineAction({
      summary: "Shout",
      description: "Upper-cases a word.",
      readOnly: true,
      mcp: true,
      input: shoutInput,
      handler: ({ input }) => ({ shouted: input.word.toUpperCase() })
    })
  },
  routes: {
    "GET /hello/:name": (_request, { params }) => Response.json({ hello: params.name })
  }
}));
