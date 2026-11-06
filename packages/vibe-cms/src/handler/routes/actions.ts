import { createRouterClient, call, type AnyProcedure, type RouterClient } from "@orpc/server";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { HttpError } from "../../config.ts";
import { coreActions, type CoreActions } from "../../actions/core.ts";
import { indexActions, inputSchemaOf, listActions, type ActionInputOf } from "../../actions/define.ts";
import { describeActions, filesFromJson } from "../../actions/describe.ts";
import { fromText } from "../../actions/inputs.ts";
import { formValues, jsonBody, jsonObject, queryValues, type SiteEnv } from "../http.ts";

/**
 * The CMS's actions over HTTP: by name, and as a REST API where each route says where an action's
 * input comes from. Mounted under `/api`.
 */
export const actions = new Hono<{ Bindings: SiteEnv["Bindings"], Variables: SiteEnv["Variables"] & { actions: RouterClient<CoreActions> } }>();

const index = indexActions(coreActions);

actions.use("*", async (c, next) => {
  c.set("actions", createRouterClient(coreActions, { context: { engine: c.get("engine") } }));
  await next();
  if(!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
});

/**
 * The query string as the action's input: numbers, booleans and lists converted by the input schema's
 * own field types, so no route lists them. Typed as that input, but only the action's validation
 * checks it, when the action runs.
 */
function coerceQuery<P extends AnyProcedure>(procedure: P) {
  const schema = inputSchemaOf(procedure);
  return validator("query", (_, c): Partial<ActionInputOf<P>> => fromText(schema, queryValues(new URL(c.req.url))) as Partial<ActionInputOf<P>>);
}

/**
 * A JSON body as an action's input, without the fields the route takes from its path. Fields the body
 * leaves out can come from the query string (`PUT /documents/post/x?locale=fr`).
 */
function body<P extends AnyProcedure, const K extends keyof ActionInputOf<P> = never>(procedure: P, ..._fromPath: K[]) {
  const schema = inputSchemaOf(procedure);
  return validator("json", async (value, c): Promise<Omit<ActionInputOf<P>, K>> => {
    return { ...fromText(schema, queryValues(new URL(c.req.url))), ...await jsonObject(value, c) } as Omit<ActionInputOf<P>, K>;
  });
}

const a = coreActions;

actions
  .get("/actions", c => c.json({ actions: describeActions(listActions(coreActions)) }))
  // Any action by name: `POST /_vibe/api/actions/documents.list` with its input as JSON or multipart.
  .post(
    "/actions/:name",
    async c => {
      const name = c.req.param("name");
      const action = index.get(name);
      if(!action) throw new HttpError(404, `No action "${name}"`);
      const type = c.req.header("content-type") ?? "";
      const input = type.includes("multipart/form-data") ? fromText(action.input, formValues(await c.req.raw.formData())) : filesFromJson(action.input, await jsonBody(c.req.raw));
      return c.json(await call(action.procedure, input, { context: { engine: c.get("engine") } }));
    }
  )
  .all("/actions/:name", () => { throw new HttpError(405, "Use POST"); })

  .get("/schema", async c => c.json(await c.var.actions.schema.list()))
  .get("/schema/:type", async c => c.json(await c.var.actions.schema.get(c.req.param())))

  .get("/site", async c => c.json(await c.var.actions.site.get()))
  .patch(
    "/site",
    body(a.site.update),
    async c => c.json(await c.var.actions.site.update(c.req.valid("json")))
  )

  .get(
    "/documents/:type",
    coerceQuery(a.documents.list),
    async c => c.json(await c.var.actions.documents.list({ ...c.req.valid("query"), ...c.req.param() }))
  )
  .post(
    "/documents/:type",
    body(a.documents.create, "type"),
    async c => c.json(await c.var.actions.documents.create({
      ...c.req.valid("json"),
      ...c.req.param()
    }), 201)
  )
  .get(
    "/documents/:type/:id",
    coerceQuery(a.documents.get),
    async c => c.json(await c.var.actions.documents.get({ ...c.req.valid("query"), ...c.req.param() }))
  )
  .put(
    "/documents/:type/:id",
    body(a.documents.update, "type", "id"),
    async c => c.json(await c.var.actions.documents.update({ ...c.req.valid("json"), ...c.req.param() }))
  )
  .delete(
    "/documents/:type/:id",
    coerceQuery(a.documents.delete),
    async c => c.json(await c.var.actions.documents.delete({
      ...c.req.valid("query"),
      ...c.req.param()
    }))
  )
  .post(
    "/documents/:type/:id/publish",
    body(a.documents.publish, "type", "id"),
    async c => c.json(await c.var.actions.documents.publish({
      ...c.req.valid("json"),
      ...c.req.param()
    }))
  )
  .post(
    "/documents/:type/:id/unpublish",
    body(a.documents.unpublish, "type", "id"),
    async c => c.json(await c.var.actions.documents.unpublish({
      ...c.req.valid("json"),
      ...c.req.param()
    }))
  )
  .get(
    "/documents/:type/:id/references",
    async c => c.json(await c.var.actions.documents.references({ ...c.req.param() }))
  )
  .get(
    "/documents/:type/:id/versions",
    coerceQuery(a.documents.versions),
    async c => c.json(await c.var.actions.documents.versions({
      ...c.req.valid("query"),
      ...c.req.param()
    }))
  )
  .get(
    "/documents/:type/:id/versions/:ver",
    coerceQuery(a.documents.version),
    async c => c.json(await c.var.actions.documents.version({
      ...c.req.valid("query"),
      type: c.req.param("type"),
      id: c.req.param("id"),
      ver: Number(c.req.param("ver"))
    }))
  )
  .post(
    "/documents/:type/:id/versions/:ver/restore",
    body(a.documents.restoreVersion, "type", "id", "ver"),
    async c => c.json(await c.var.actions.documents.restoreVersion({
      ...c.req.valid("json"),
      type: c.req.param("type"),
      id: c.req.param("id"),
      ver: Number(c.req.param("ver"))
    }))
  )
  .post(
    "/documents/:type/:id/schedule",
    body(a.documents.schedule, "type", "id"),
    async c => c.json(await c.var.actions.documents.schedule({
      ...c.req.valid("json"),
      ...c.req.param()
    }))
  )
  .delete(
    "/documents/:type/:id/schedule",
    coerceQuery(a.documents.unschedule),
    async c => c.json(await c.var.actions.documents.unschedule({
      ...c.req.valid("query"),
      ...c.req.param()
    }))
  )

  .get(
    "/assets",
    coerceQuery(a.assets.list),
    async c => c.json(await c.var.actions.assets.list(c.req.valid("query")))
  )
  .post(
    "/assets",
    async c => {
      const input = fromText(inputSchemaOf(a.assets.upload), formValues(await c.req.raw.formData())) as ActionInputOf<typeof a.assets.upload>;
      return c.json(await c.var.actions.assets.upload(input), 201);
    }
  )
  .get("/assets/:id", async c => c.json(await c.var.actions.assets.get(c.req.param())))
  .patch(
    "/assets/:id",
    body(a.assets.update, "id"),
    async c => c.json(await c.var.actions.assets.update({
      ...c.req.valid("json"),
      id: c.req.param("id")
    }))
  )
  .delete("/assets/:id", async c => c.json(await c.var.actions.assets.delete(c.req.param())))
  // The file's new content is the request body itself.
  .put(
    "/assets/:id/content",
    async c => c.json(await c.var.actions.assets.replaceContent({
      id: c.req.param("id"),
      content: await c.req.text()
    }))
  )
  .delete("/assets/:id/metadata", async c => c.json(await c.var.actions.assets.stripMetadata({ id: c.req.param("id") })))

  .get("/folders", async c => c.json(await c.var.actions.folders.list()))
  .post(
    "/folders",
    body(a.folders.create),
    async c => c.json(await c.var.actions.folders.create(c.req.valid("json")), 201)
  )
  .patch(
    "/folders",
    body(a.folders.move),
    async c => c.json(await c.var.actions.folders.move(c.req.valid("json")))
  )
  .delete(
    "/folders",
    coerceQuery(a.folders.delete),
    async c => c.json(await c.var.actions.folders.delete(c.req.valid("query") as ActionInputOf<typeof a.folders.delete>))
  )

  .get("/trash", async c => c.json(await c.var.actions.trash.list()))
  .delete("/trash", async c => c.json(await c.var.actions.trash.empty()))
  .get("/trash/:id", async c => c.json(await c.var.actions.trash.get(c.req.param())))
  .delete("/trash/:id", async c => c.json(await c.var.actions.trash.purge(c.req.param())))
  .post("/trash/:id/restore", async c => c.json(await c.var.actions.trash.restore(c.req.param())));
