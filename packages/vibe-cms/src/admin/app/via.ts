import type { Via } from "../../handler/activity.ts";

/** How each channel an action can come through is named in the editor and the panel. */
export const VIA_LABELS: Record<Via, string> = {
  ui: "Editor",
  rest: "API",
  mcp: "Agent (MCP)",
  cli: "CLI",
  plugin: "Plugin",
  cron: "Schedule",
  hub: "Hub"
};
