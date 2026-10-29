import { defineServer } from "../src/server/index.ts";
import { calls, type AuditPlugin } from "./fixture.ts";

export default defineServer<typeof AuditPlugin>(async ({ options }) => ({
  "content.beforeWrite": async ({ type, action }, output) => {
    calls.push(`beforeWrite:${type}:${action}`);
    if(type === "post") output.doc.searchText = `${options.tag}:${String(output.doc.title ?? "").toLowerCase()}`;
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
