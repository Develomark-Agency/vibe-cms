import { coreActions } from "../actions/core.ts";
import { runAction, type ActionContext, type AnyAction } from "../actions/define.ts";
import { filesFromJson } from "../actions/describe.ts";
import { actionTools, serveMcp, toolName, toolResult, type McpTool } from "../actions/mcp.ts";
import pkg from "../../package.json" with { type: "json" };

/** A site's own MCP server: every action is a tool, run with the request's site session. */

const INSTRUCTIONS = `Content management for this site.
Call schema_list for the content types, then schema_get for a type's fields before creating or updating its documents.
Documents are drafts until published. Pass a document's updatedAt as baseUpdatedAt when updating, so you don't overwrite someone else's edit.
Deleting moves things to the trash; trash_purge and trash_empty can't be undone.`;

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
