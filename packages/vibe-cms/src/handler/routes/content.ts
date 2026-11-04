import { Hono } from "hono";
import { HttpError } from "../../config.ts";
import type { SerializedQuery } from "../../query/index.ts";
import { cors, jsonInput, type SiteEnv } from "../http.ts";

/** Reading content and files: the public query API, media, and trashed files. */
export const content = new Hono<SiteEnv>();

content.get("/media/*", c => {
  const { state } = c.env;
  const name = new URL(c.req.url).pathname.slice(`${state.prefix}/media/`.length);
  return c.get("engine").serveAsset(name, c.req.raw);
});

/** The public query API and trashed files, under `/api`. */
export const query = new Hono<SiteEnv>()
  .use("/query", cors)
  .post("/query", jsonInput<{ queries: SerializedQuery[] }>(), async c => {
    const { queries } = c.req.valid("json");
    if(!Array.isArray(queries) || queries.length > 50) throw new HttpError(400, "Expected 1-50 queries");
    return c.json({ results: await c.get("engine").execute(queries) });
  })
  .all("/query", () => {
    throw new HttpError(405, "Use POST");
  })

  .get("/trash/:id/file", c => c.get("engine").trashFile(c.req.param("id")));
