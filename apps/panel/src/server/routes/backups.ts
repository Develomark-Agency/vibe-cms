import { Hono } from "hono";
import type { Next } from "hono";
import { eq } from "drizzle-orm";
import { PanelError } from "vibe-cms/panel";
import { packSnapshot } from "vibe-cms/backups";
import { bucketStore, canRestore, cleanPolicy, defaultPolicy, enqueue, processBackups, savePolicy, siteBackups } from "../backups.ts";
import { hubOrg } from "../hub.ts";
import * as t from "../schema.ts";
import { db, siteById } from "../shared.ts";
import { waitUntil, type AppContext, type AppEnv } from "../context.ts";
import { policyBody, restoreBody, sitePolicyBody } from "./validate.ts";

function kick(c: AppContext, siteId: string) {
  // Starts at once; if this Worker stops first, the cron trigger takes the run over.
  waitUntil(c, () => processBackups(c.env, { siteId, schedule: false, budget: 25_000 }).catch(error => console.error(error)));
}

async function backedUpSite(c: AppContext) {
  const site = await siteById(c.env, c.req.param("id")!);
  if(!site) throw new PanelError(404, "Unknown site");
  return site;
}

/** Everything but reading a site's backups needs the archive bucket. */
async function requireBucket(c: AppContext, next: Next) {
  if(!c.env.BACKUPS && c.req.method !== "GET") throw new PanelError(501, "This panel has no BACKUPS bucket");
  await next();
}

/**
 * `/backups…` and `/sites/:id/backups…`, mounted under `/api`: scheduled snapshots and restores.
 * Written as one chain so `hc<PanelApi>` can read the routes' types.
 */
export const backups = new Hono<AppEnv>()
  .get("/backups", async c => {
    const env = c.env;
    return c.json({ available: Boolean(env.BACKUPS), panel: env.VIBE_ORG ? hubOrg(env) : null, defaults: await defaultPolicy(env) });
  })

  .get("/backups/download", async c => {
    const env = c.env;
    const [row] = await db(env).select().from(t.backupSnapshots).where(eq(t.backupSnapshots.id, c.req.query("snapshot") ?? ""));
    if(!row || !env.BACKUPS) throw new PanelError(404, "Unknown snapshot");
    const site = await siteById(env, row.site_id);
    const slug = (site?.name ?? row.site_id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
    const stamp = new Date(row.taken_at).toISOString().slice(0, 16).replace(/[T:]/g, "-");
    // Streams from the archive as it's packed; nothing is built up in memory.
    return new Response(await packSnapshot(bucketStore(env.BACKUPS), row.id), {
      headers: {
        "content-type": "application/gzip",
        "content-disposition": `attachment; filename="${slug}-${stamp}.vibe"`,
        "cache-control": "no-store"
      }
    });
  })

  .put("/backups/defaults", policyBody, async c => {
    await savePolicy(c.env, "*", cleanPolicy(c.req.valid("json").policy), c.get("session").sub);
    return c.json({ defaults: await defaultPolicy(c.env) });
  })

  .get("/sites/:id/backups", async c => c.json(await siteBackups(c.env, await backedUpSite(c))))

  .post("/sites/:id/backups", requireBucket, async c => {
    const site = await backedUpSite(c);
    const session = c.get("session");
    const id = await enqueue(c.env, site.id, "manual", { user: session.email ?? session.sub });
    kick(c, site.id);
    return c.json({ run: id }, 202);
  })

  .put("/sites/:id/backups/policy", requireBucket, sitePolicyBody, async c => {
    const site = await backedUpSite(c);
    const { policy } = c.req.valid("json");
    await savePolicy(c.env, site.id, policy === null ? null : cleanPolicy(policy), c.get("session").sub);
    return c.json(await siteBackups(c.env, site));
  })

  .post("/sites/:id/backups/restore", requireBucket, restoreBody, async c => {
    const site = await backedUpSite(c);
    const session = c.get("session");
    const { snapshot } = c.req.valid("json");
    const [row] = await db(c.env).select().from(t.backupSnapshots).where(eq(t.backupSnapshots.id, snapshot));
    if(!row) throw new PanelError(404, "Unknown snapshot");
    await canRestore(c.env, session, site);
    const id = await enqueue(c.env, site.id, "restore", { snapshot: row.id, user: session.email ?? session.sub });
    kick(c, site.id);
    return c.json({ run: id }, 202);
  });
