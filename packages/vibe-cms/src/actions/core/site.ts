import { z } from "zod";
import { base, router } from "../define.ts";

const siteGet = base({
  summary: "Get site settings",
  description: "The site's name, accent colour, icon, and whether uploads lose their location and camera details.",
  readOnly: true
})
  .handler(({ context: { engine } }) => engine.site());

const siteUpdate = base({
  summary: "Update site settings",
  description: "Changes the site's name, accent colour (#rrggbb, or null for the default), icon (an image's asset ID, or null), or whether uploads remove photos' location and camera details by default.",
  idempotent: true
})
  .input(z.object({
    name: z.string().optional(),
    accent: z.string().nullable().optional(),
    icon: z.string().nullable().optional().describe("Asset ID of an image"),
    stripMetadata: z.boolean().optional().describe("Remove location and camera details from uploaded photos by default")
  }))
  .handler(({ context: { engine }, input }) => engine.updateSite(input));

const siteSetBackupAccess = base({
  summary: "Allow scheduled backups",
  description: "Lets the site's hub (the panel of its org) back the site up on a schedule and restore snapshots, with no one signed in, or stops it. It's off by default. A snapshot reads every document and file, drafts included, and a restore replaces them all. Needs `manageScheduledBackups` in the user's role.",
  idempotent: true
})
  .input(z.object({ enabled: z.boolean().describe("true to let the hub back the site up, false to stop it") }))
  .handler(({ context: { engine }, input }) => engine.setBackupAccess(input.enabled));

export const site = router({
  get: siteGet,
  update: siteUpdate,
  setBackupAccess: siteSetBackupAccess
});
