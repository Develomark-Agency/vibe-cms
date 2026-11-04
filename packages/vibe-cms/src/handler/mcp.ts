import { coreActions } from "../actions/core.ts";
import { indexActions, type ActionContext } from "../actions/define.ts";
import { actionTools, CONTENT_INSTRUCTIONS, runTool, serveMcp, toolName, type McpTool } from "../actions/mcp.ts";
import pkg from "../../package.json" with { type: "json" };

/** A site's own MCP server: every action is a tool, run with the request's site session. */

const INSTRUCTIONS = `Content management for this site: its documents, media library, translations and trash. Every tool runs as the signed-in user, with their permissions.

${CONTENT_INSTRUCTIONS}`;

const actions = indexActions(coreActions);
const tools = new Map([...actions.values()].map(action => [toolName(action.name), action]));

let toolList: McpTool[] | undefined;

export function handleMcp(request: Request, ctx: ActionContext): Promise<Response> {
  return serveMcp(request, {
    name: "vibe-cms",
    version: pkg.version,
    instructions: INSTRUCTIONS,
    tools: () => (toolList ??= actionTools([...actions.values()])),
    async call(name, args) {
      const action = tools.get(name);
      return action ? runTool(action, ctx, args) : null;
    }
  });
}
