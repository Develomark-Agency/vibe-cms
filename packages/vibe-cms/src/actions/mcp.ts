import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { runAction, type ActionContext, type ActionEntry } from "./define.ts";
import { describeActions, filesFromJson } from "./describe.ts";
import { isActionError } from "./errors.ts";

/**
 * MCP over Streamable HTTP, served by the official SDK without sessions: just tools.
 * Shared by a site's own `/_vibe/api/mcp` and the panel's `/mcp`, which differ only in
 * where tools come from and how a call runs.
 */

/** A tool as MCP's `tools/list` returns it. */
export interface McpTool {
  name: string,
  title: string,
  description: string,
  inputSchema: Record<string, unknown>,
  annotations: {
    title: string,
    readOnlyHint: boolean,
    destructiveHint: boolean,
    idempotentHint: boolean,
    openWorldHint: boolean
  }
}

/** A `tools/call` result: JSON text, flagged as an error on failure. */
export interface ToolResult {
  content: Array<{ type: "text", text: string }>,
  structuredContent?: unknown,
  isError?: boolean
}

/** What `serveMcp` serves: its identity, instructions for the agent, tools and how to call them. */
export interface McpServer {
  name: string,
  version: string,
  instructions: string,
  tools(): McpTool[] | Promise<McpTool[]>,
  /** `null` for an unknown tool. */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult | null>
}

/**
 * How to use the content tools, shared by a site's own MCP server and the panel's. It says
 * nothing about how the agent connected, which differs between development and deployed sites.
 */
export const CONTENT_INSTRUCTIONS = `Workflow:
- Call schema_list for the content types and locales, then schema_get for a type before writing its documents: it returns JSON Schema for \`data\`.
- Content types are defined in the site's code (vibe-cms.config.ts). These tools can't add or change fields; that's a code change (\`npx vibe-cms docs schemas\` in the site's repository).
- documents_create and documents_update save drafts. Drafts save even when invalid and return \`issues\`; documents_publish (or \`publish: true\`) needs a valid document.
- documents_update replaces the draft's fields: read the document with documents_get, change what you need, send all of \`data\` back, and pass its updatedAt as baseUpdatedAt so you don't overwrite someone else's edit (that fails with CONFLICT).
- Media fields take \`{ "asset": "<id>", ...per-usage fields such as alt }\`. Upload with assets_upload first: \`file\` is \`{ name, type?, base64 }\` (type being its MIME type), and the input's own \`type\` and \`field\` (content type and field name) check the file against that field.
- Reference fields take document IDs; references to any type take \`{ type, id }\`. A referenced document can't be deleted until nothing points at it (documents_references lists what does).
- Pass \`locale\` to read or write a translation; updating a document in a new locale creates that translation. Each locale is published separately.
- Deleting moves things to the trash (trash_restore brings them back); trash_purge and trash_empty can't be undone.
- Errors carry a code: UNPROCESSABLE_CONTENT (validation, with data.issues), CONFLICT, FORBIDDEN (the user's role doesn't allow it), NOT_FOUND, BAD_REQUEST.`;

/** MCP tool names can't contain dots in every client. */
export function toolName(action: string): string {
  return action.replaceAll(".", "_");
}

/** Action names in descriptions, as tools are named: `schema.get` → `schema_get`. */
function mentions(text: string): string {
  return text.replace(/`(\w+)\.(\w+)`/g, (_, group: string, verb: string) => `\`${group}_${verb}\``);
}

function mentionsIn(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema), (key, value) => (key === "description" && typeof value === "string" ? mentions(value) : value));
}

/** Every action as a tool. `input` can add to each input schema, e.g. the panel's `site`. */
export function actionTools(actions: ActionEntry[], options: { input?: (schema: Record<string, unknown>) => Record<string, unknown> } = {}): McpTool[] {
  return describeActions(actions, { files: "json" }).map(action => ({
    name: toolName(action.name),
    title: action.title,
    description: mentions(action.description),
    inputSchema: mentionsIn(options.input ? options.input(action.input) : action.input),
    annotations: {
      title: action.title,
      readOnlyHint: action.annotations.readOnly ?? false,
      destructiveHint: action.annotations.destructive ?? false,
      idempotentHint: action.annotations.idempotent ?? action.annotations.readOnly ?? false,
      openWorldHint: false
    }
  }));
}

/** A successful tool result carrying `value` as JSON. */
export function textResult(value: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(typeof value === "object" && value !== null && !Array.isArray(value) ? { structuredContent: value } : {})
  };
}

/** A failed tool result: `[CODE] message`, then the error's `data`. */
export function errorResult(error: { code: string, message: string, data?: unknown }): ToolResult {
  const data = error.data === undefined ? "" : `\n${JSON.stringify(error.data, null, 2)}`;
  return { isError: true, content: [{ type: "text", text: `[${error.code}] ${error.message}${data}` }] };
}

/** Runs an action for a tool call: its output, or the failure, as a tool result. Anything but an action's own error is a bug and keeps throwing. */
export async function runTool(action: ActionEntry, ctx: ActionContext, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    return textResult(await runAction(action, ctx, filesFromJson(action.input, args)));
  } catch (error) {
    if(isActionError(error)) return errorResult(error);
    throw error;
  }
}

function forbidden(): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Cross-origin requests aren't allowed" } }, { status: 403 });
}

/**
 * Answers one MCP request through the official SDK, statelessly: a server and transport
 * per request, JSON responses, no sessions. Authenticate before calling it.
 */
export async function serveMcp(request: Request, tools: McpServer): Promise<Response> {
  // Browsers on other sites must not drive it through a signed-in user (DNS rebinding included).
  const origin = request.headers.get("origin");
  if(origin && origin !== new URL(request.url).origin) return forbidden();

  const server = new Server(
    { name: tools.name, title: tools.name, version: tools.version },
    { capabilities: { tools: { listChanged: false } }, instructions: tools.instructions }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await tools.tools() as never }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    const result = await tools.call(params.name, params.arguments ?? {});
    if(!result) throw new McpError(ErrorCode.InvalidParams, `Unknown tool "${params.name}"`);
    return result as never;
  });

  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // JSON responses are complete by now.
    await server.close();
  }
}
