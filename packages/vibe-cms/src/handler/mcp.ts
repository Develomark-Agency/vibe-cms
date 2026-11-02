import { coreActions } from "../actions/core.ts";
import { runAction, type ActionContext, type AnyAction } from "../actions/define.ts";
import { filesFromJson } from "../actions/describe.ts";
import { actionTools, CONTENT_INSTRUCTIONS, serveMcp, toolName, toolResult, type McpTool } from "../actions/mcp.ts";
import pkg from "../../package.json" with { type: "json" };

/** A site's own MCP server: every action is a tool, run with the request's site session. */

const INSTRUCTIONS = `Content management for this site: its documents, media library, translations and trash. Every tool runs as the signed-in user, with their permissions.

${CONTENT_INSTRUCTIONS}`;

const tools = new Map<string, AnyAction>(Object.values(coreActions).map(action => [toolName(action.name), action as AnyAction]));

let toolList: McpTool[] | undefined;

export function handleMcp(request: Request, ctx: ActionContext): Promise<Response> {
  return serveMcp(request, {
    name: "vibe-cms",
    version: pkg.version,
    instructions: INSTRUCTIONS,
    tools: () => (toolList ??= actionTools(coreActions)),
    async call(name, args) {
      const action = tools.get(name);
      if(!action) return null;
      return toolResult(await runAction(action, ctx, filesFromJson(action, args)));
    }
  });
}
