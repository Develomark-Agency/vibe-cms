import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import { coreActions, type CoreActions } from "../../actions/core.ts";
import { runAction, type AnyAction } from "../../actions/define.ts";
import { describeActions, filesFromJson } from "../../actions/describe.ts";
import { fromText } from "../../actions/inputs.ts";
import { errorResponse, formValues, json, jsonBody, queryValues, type SiteEnv } from "../http.ts";

/** The CMS's actions over HTTP: by name, and as a REST API. Mounted under `/api`. */
export const actions = new Hono<SiteEnv>();

actions.get("/actions", () => json({ actions: describeActions(coreActions) }));

/** Any action by name: `POST /_vibe/api/actions/documents.list` with its input as JSON or multipart. */
actions.post("/actions/:name", async c => {
  const name = c.req.param("name");
  const action = (coreActions as Record<string, AnyAction>)[name];
  if(!action) throw new HttpError(404, `No action "${name}"`);
  const type = c.req.header("content-type") ?? "";
  const input = type.includes("multipart/form-data") ? fromText(action.input, formValues(await c.req.raw.formData())) : filesFromJson(action, await jsonBody(c.req.raw));
  const result = await runAction(action, { engine: c.get("engine") }, input);
  return result.isOk() ? json(result.value) : errorResponse(result.error);
});
actions.all("/actions/:name", () => {
  throw new HttpError(405, "Use POST");
});

interface RestRoute {
  /** `METHOD /path/:param`, relative to `/_vibe/api`. */
  route: string,
  action: keyof CoreActions,
  status?: number,
  /** How the body carries input: JSON (the default), multipart form fields, or raw text as one field. */
  body?: "form" | { text: string }
}

/**
 * The REST API: each route only says where an action's input comes from. Path params,
 * then the body, then the query string, in that order of precedence.
 */
const restRoutes: RestRoute[] = [
  { route: "GET /schema", action: "schema.list" },
  { route: "GET /schema/:type", action: "schema.get" },
  { route: "GET /site", action: "site.get" },
  { route: "PATCH /site", action: "site.update" },
  { route: "GET /documents/:type", action: "documents.list" },
  { route: "POST /documents/:type", action: "documents.create", status: 201 },
  { route: "GET /documents/:type/:id", action: "documents.get" },
  { route: "PUT /documents/:type/:id", action: "documents.update" },
  { route: "DELETE /documents/:type/:id", action: "documents.delete" },
  { route: "POST /documents/:type/:id/publish", action: "documents.publish" },
  { route: "POST /documents/:type/:id/unpublish", action: "documents.unpublish" },
  { route: "GET /documents/:type/:id/references", action: "documents.references" },
  { route: "GET /documents/:type/:id/versions", action: "documents.versions" },
  { route: "GET /documents/:type/:id/versions/:ver", action: "documents.version" },
  { route: "POST /documents/:type/:id/versions/:ver/restore", action: "documents.restoreVersion" },
  { route: "POST /documents/:type/:id/schedule", action: "documents.schedule" },
  { route: "DELETE /documents/:type/:id/schedule", action: "documents.unschedule" },
  { route: "GET /assets", action: "assets.list" },
  { route: "POST /assets", action: "assets.upload", status: 201, body: "form" },
  { route: "GET /assets/:id", action: "assets.get" },
  { route: "PATCH /assets/:id", action: "assets.update" },
  { route: "DELETE /assets/:id", action: "assets.delete" },
  { route: "PUT /assets/:id/content", action: "assets.replaceContent", body: { text: "content" } },
  { route: "GET /folders", action: "folders.list" },
  { route: "POST /folders", action: "folders.create", status: 201 },
  { route: "PATCH /folders", action: "folders.move" },
  { route: "DELETE /folders", action: "folders.delete" },
  { route: "GET /trash", action: "trash.list" },
  { route: "DELETE /trash", action: "trash.empty" },
  { route: "GET /trash/:id", action: "trash.get" },
  { route: "DELETE /trash/:id", action: "trash.purge" },
  { route: "POST /trash/:id/restore", action: "trash.restore" }
];

async function restBody(request: Request, entry: RestRoute, schema: AnyAction["input"]): Promise<Record<string, unknown>> {
  if(request.method === "GET" || request.method === "DELETE") return {};
  if(entry.body === "form") return fromText(schema, formValues(await request.formData()));
  if(entry.body) return { [entry.body.text]: await request.text() };
  return jsonBody(request);
}

for(const entry of restRoutes) {
  const [method, path] = entry.route.split(" ") as [string, string];
  const action = coreActions[entry.action];
  actions.on(method, path, async c => {
    const input = { ...fromText(action.input, queryValues(new URL(c.req.url))), ...await restBody(c.req.raw, entry, action.input), ...fromText(action.input, c.req.param()) };
    const result = await runAction(action, { engine: c.get("engine") }, input);
    return result.isOk() ? json(result.value, { status: entry.status ?? 200 }) : errorResponse(result.error);
  });
}
