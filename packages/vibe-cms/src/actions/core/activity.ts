import { z } from "zod";
import { VIA } from "../../handler/activity.ts";
import { base, router } from "../define.ts";

const activityList = base({
  summary: "List activity",
  description: "Who did what and when, through which channel (`ui`, `rest`, `mcp`, `cli`, `plugin`, `cron`, `hub`), on what, and whether it worked: every change, refused permission checks and sensitive reads, newest first. People whose role has `viewActivity` (and owners) see everyone's; everyone else sees their own. Pass `next` back as `cursor` for the next page.",
  readOnly: true
})
  .input(z.object({
    actor: z.string().optional().describe("A user's ID (`sub`), or `system:cron` / `system:hub`"),
    via: z.enum(VIA as [string, ...string[]]).optional(),
    action: z.string().optional().describe("An action name (`documents.publish`) or a group (`documents`)"),
    targetId: z.string().optional().describe("A document, file or other item's ID"),
    since: z.number().optional().describe("Milliseconds since the epoch"),
    until: z.number().optional().describe("Milliseconds since the epoch"),
    ok: z.boolean().optional().describe("Only successes (true) or failures (false)"),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional()
  }))
  .handler(({ context: { engine }, input }) => engine.listActivity(input as Parameters<typeof engine.listActivity>[0]));

const activityRetention = base({
  summary: "Get how long activity is kept",
  description: "How many days the activity log keeps entries before removing them automatically.",
  readOnly: true
})
  .handler(({ context: { engine } }) => engine.activityRetention());

const activitySetRetention = base({
  summary: "Set how long activity is kept",
  description: "Changes how many days the activity log keeps entries (90 by default). Needs `manageActivity` in the user's role. A shorter period removes older entries soon after.",
  idempotent: true
})
  .input(z.object({ days: z.number().int().min(1).max(3650).describe("Days to keep it, 1 to 3650") }))
  .handler(({ context: { engine }, input }) => engine.setActivityRetention(input.days));

export const activity = router({
  retention: activityRetention,
  setRetention: activitySetRetention,
  list: activityList
});
