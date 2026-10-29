import { defineServer } from "../src/server/index.ts";
import { calls, type AuditPlugin, type config } from "./fixture.ts";

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
  routes: {
    "GET /hello/:name": (_request, { params }) => Response.json({ hello: params.name })
  }
}));
