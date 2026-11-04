import { Hono } from "hono";
import { transferRoute } from "../backups.ts";
import { cors, type SiteEnv } from "../http.ts";

/** Signed links from the backup actions; the signature stands in for a session. */
export const backupTransfers = new Hono<SiteEnv>();

backupTransfers.use("/api/backups/files/*", cors);
backupTransfers.all("/api/backups/files/*", async c => {
  const { state } = c.env;
  const url = new URL(c.req.url);
  const key = url.pathname.slice(`${state.prefix}/api/backups/files/`.length).split("/").map(decodeURIComponent).join("/");
  return transferRoute(c.req.raw, state.db, state.storage, url, key);
});
