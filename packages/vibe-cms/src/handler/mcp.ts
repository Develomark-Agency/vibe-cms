import { type ActionContext } from "../actions/define.ts";
import { actionTools, CONTENT_INSTRUCTIONS, runTool, serveMcp, toolName, type McpTool } from "../actions/mcp.ts";
import type { ActionRegistry, PluginHost } from "./plugins.ts";
import pkg from "../../package.json" with { type: "json" };

/** A site's own MCP server: every action marked for agents is a tool, run with the request's site session. */

const BASE = `Content management for this site: its documents, media library, translations and trash. Every tool runs as the signed-in user, with their permissions.

${CONTENT_INSTRUCTIONS}`;

/** What a site's MCP server serves, built once per site: the tools, how to run one, and the instructions. */
interface SiteMcp {
  instructions: string,
  tools: McpTool[],
  byName: Map<string, ActionRegistry["list"][number]>
}

const built = new WeakMap<PluginHost, SiteMcp>();

function siteMcp(plugins: PluginHost): SiteMcp {
  let site = built.get(plugins);
  if(site) return site;
  const exposed = plugins.actions().list.filter(action => action.mcp);
  const notes = Object.entries(plugins.mcpInstructions()).map(([name, text]) => `${name} plugin:\n${text}`);
  site = {
    instructions: [BASE, ...notes].join("\n\n"),
    tools: actionTools(exposed),
    byName: new Map(exposed.map(action => [toolName(action.name), action]))
  };
  built.set(plugins, site);
  return site;
}

export function handleMcp(request: Request, ctx: ActionContext, plugins: PluginHost): Promise<Response> {
  const site = siteMcp(plugins);
  return serveMcp(request, {
    name: "vibe-cms",
    version: pkg.version,
    instructions: site.instructions,
    tools: () => site.tools,
    async call(name, args) {
      const action = site.byName.get(name);
      return action ? runTool(action, ctx, args) : null;
    }
  });
}
