import { z } from "zod";
import { base, router } from "../define.ts";

const siteGet = base({
  summary: "Get site settings",
  description: "The site's name, accent colour and icon.",
  readOnly: true
})
  .handler(({ context: { engine } }) => engine.site());

const siteUpdate = base({
  summary: "Update site settings",
  description: "Changes the site's name, accent colour (#rrggbb, or null for the default) or icon (an image's asset ID, or null).",
  idempotent: true
})
  .input(z.object({
    name: z.string().optional(),
    accent: z.string().nullable().optional(),
    icon: z.string().nullable().optional().describe("Asset ID of an image")
  }))
  .handler(({ context: { engine }, input }) => engine.updateSite(input));

export const site = router({
  get: siteGet,
  update: siteUpdate
});
