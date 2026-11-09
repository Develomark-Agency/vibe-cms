import { actionTools, CONTENT_INSTRUCTIONS, coreActions, errorResult, indexActions, listActions, serveMcp, textResult, toolName, type McpTool, type ToolResult } from "vibe-cms/actions";
import { PanelError, type PanelSite } from "vibe-cms/panel";
import { SCOPE_READ, type GrantRow } from "./oauth.ts";
import { apiBase, codeFor } from "./hub.ts";
import { and, eq } from "drizzle-orm";
import * as t from "./schema.ts";
import { db, siteById, type Env, type SessionRow } from "./shared.ts";
import { hubAccess, visibleSiteIds } from "./access.ts";
import { attachSite } from "./sites.ts";

/**
 * The panel's MCP server: the same tools as a site's own, plus `sites_list`, with
 * a `site` argument. Each call goes to that site's actions endpoint with a site
 * session the panel gets for the agent's user, so the site decides what's allowed.
 */

const INSTRUCTIONS = `Content management for the sites in this agency panel. To add a newly deployed site, call sites_attach with the claim link the site logged. Otherwise call sites_list first; every other tool takes the site's id as \`site\`.
Each call runs on that site as the signed-in user, and each site decides what they may do there: a Forbidden error means this user can't, not that the tool is broken. Read-only connections only have read-only tools.
Sites can have extra actions from their plugins (like seo.audit). They aren't listed as tools: call site_actions_list with the site to see its extras, with their inputs and notes, then run one with site_action_call.

${CONTENT_INSTRUCTIONS}`;

const actions = new Map([...indexActions(coreActions).values()].map(action => [toolName(action.name), action]));

const sitesList: McpTool = {
  name: "sites_list",
  title: "List sites",
  description: "The sites in this panel. Pass a site's `id` as `site` to every other tool. Being listed doesn't mean the user may edit it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "List sites", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

const sitesAttach: McpTool = {
  name: "sites_attach",
  title: "Attach a site",
  description: "Add a newly deployed site to this panel. Pass its claim link: the address, ending in #claim=…, that the site logs once when it's deployed without an org. The panel tells the site which org it belongs to, adds it, and makes the user its owner. Needs the user's permission to add sites; a link works once.",
  inputSchema: {
    type: "object",
    properties: { link: { type: "string", description: "The site's claim link, like https://client.com/_vibe/admin/#claim=…" } },
    required: ["link"],
    additionalProperties: false
  },
  annotations: { title: "Attach a site", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
};

const siteActionsList: McpTool = {
  name: "site_actions_list",
  title: "List a site's plugin actions",
  description: "The extra actions a site's plugins offer to agents, with what each takes, plus any notes the plugins give on using them. The content tools (documents_*, assets_*, …) aren't repeated here. Run one with site_action_call.",
  inputSchema: {
    type: "object",
    properties: { site: { type: "string", description: "The site's id, from sites_list" } },
    required: ["site"],
    additionalProperties: false
  },
  annotations: { title: "List a site's plugin actions", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

const siteActionCall: McpTool = {
  name: "site_action_call",
  title: "Run a site's plugin action",
  description: "Runs one of the actions site_actions_list showed for a site, as the signed-in user. Whether it changes anything depends on the action: check its annotations in the listing.",
  inputSchema: {
    type: "object",
    properties: {
      site: { type: "string", description: "The site's id, from sites_list" },
      action: { type: "string", description: "The action's name from site_actions_list, like seo.audit" },
      input: { type: "object", description: "What the action takes, per its input schema in site_actions_list", additionalProperties: true }
    },
    required: ["site", "action"],
    additionalProperties: false
  },
  // It may be anything the plugin does, so it doesn't claim to be read-only: read-only connections get it
  // only for actions that say they are.
  annotations: { title: "Run a site's plugin action", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
};

let siteTools: McpTool[] | undefined;

function allTools(): McpTool[] {
  siteTools ??= actionTools(listActions(coreActions), {
    input: schema => ({
      ...schema,
      properties: { site: { type: "string", description: "The site's id, from sites_list" }, ...(schema.properties as object) },
      required: ["site", ...((schema.required as string[] | undefined) ?? [])]
    })
  });
  return [sitesList, sitesAttach, siteActionsList, siteActionCall, ...siteTools];
}

/** A site session for the agent's (or CLI's) user: cached, or from the same handoff the editor uses. */
export async function siteToken(env: Env, grant: GrantRow, session: SessionRow, site: PanelSite, fresh = false): Promise<string> {
  if(!fresh) {
    const [cached] = await db(env).select({ token: t.agentSiteTokens.token, expires_at: t.agentSiteTokens.expires_at }).from(t.agentSiteTokens)
      .where(and(eq(t.agentSiteTokens.grant_id, grant.id), eq(t.agentSiteTokens.site_id, site.id)));
    if(cached && cached.expires_at > Date.now() + 60_000) return cached.token;
  }
  const code = await codeFor(env, session, site);
  const response = await fetch(`${apiBase(site)}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code })
  });
  const data = await response.json().catch(() => ({})) as { token?: string, expiresAt?: number, error?: string };
  if(!response.ok || !data.token) throw new PanelError(502, data.error ?? `The site refused the sign-in (${response.status})`);
  const expiresAt = (data.expiresAt ?? 0) * 1000;
  await db(env).insert(t.agentSiteTokens)
    .values({ grant_id: grant.id, site_id: site.id, token: data.token, expires_at: expiresAt })
    .onConflictDoUpdate({ target: [t.agentSiteTokens.grant_id, t.agentSiteTokens.site_id], set: { token: data.token, expires_at: expiresAt } });
  return data.token;
}

/** One request to a site's API as the grant's user. A 401 may be a dropped session (expired, keys rotated): it gets a new one, once. */
async function siteRequest(env: Env, grant: GrantRow, session: SessionRow, site: PanelSite, path: string, init: { method: string, body?: string }): Promise<Response | null> {
  for(const fresh of [false, true]) {
    const token = await siteToken(env, grant, session, site, fresh);
    const response = await fetch(`${apiBase(site)}${path}`, {
      method: init.method,
      // The site's activity log records these as agent calls through the panel.
      headers: { ...(init.body === undefined ? {} : { "content-type": "application/json" }), authorization: `Bearer ${token}`, "x-vibe-via": "mcp", "x-vibe-client": "vibe-panel" },
      body: init.body
    });
    if(response.status === 401 && !fresh) continue;
    return response;
  }
  return null;
}

const SESSION_REFUSED = { code: "UNAUTHORIZED", message: "The site keeps refusing this user's session" };

async function forward(env: Env, grant: GrantRow, session: SessionRow, site: PanelSite, action: string, input: Record<string, unknown>) {
  const response = await siteRequest(env, grant, session, site, `/api/actions/${action}`, { method: "POST", body: JSON.stringify(input) });
  if(!response) return errorResult(SESSION_REFUSED);
  const body = await response.json().catch(() => ({ error: `The site answered ${response.status}` })) as Record<string, unknown>;
  if(response.ok) return textResult(body);
  return errorResult({ code: String(body.code ?? "SERVICE_UNAVAILABLE"), message: String(body.error ?? response.statusText), data: body.data });
}

/** An action a site's plugins offer to agents, as `GET /api/actions` describes it. */
interface PluginAction {
  name: string,
  title: string,
  description: string,
  annotations: { readOnly?: boolean },
  input: Record<string, unknown>
}

interface SitePlugins {
  actions: PluginAction[],
  /** The plugins' notes on using their tools, by plugin name. */
  instructions: Record<string, string>
}

const LISTING_TTL = 30_000;
const listings = new Map<string, { at: number, plugins: SitePlugins }>();

/** The agent-callable plugin actions of a site, kept for a moment: the same for every user, and asked for by every call. */
async function pluginActions(env: Env, grant: GrantRow, session: SessionRow, site: PanelSite): Promise<SitePlugins | ToolResult> {
  const cached = listings.get(site.id);
  if(cached && cached.at > Date.now() - LISTING_TTL) return cached.plugins;
  const response = await siteRequest(env, grant, session, site, "/api/actions", { method: "GET" });
  if(!response) return errorResult(SESSION_REFUSED);
  const body = await response.json().catch(() => null) as { actions?: Array<PluginAction & { mcp: boolean, plugin?: string }>, instructions?: Record<string, string>, error?: string } | null;
  if(!response.ok || !body?.actions) return errorResult({ code: "SERVICE_UNAVAILABLE", message: body?.error ?? `The site answered ${response.status}` });
  const plugins = {
    // The built-in ones are the native tools; `mcp` is the site's own word on what agents may run.
    actions: body.actions.filter(action => action.plugin && action.mcp).map(({ name, title, description, annotations, input }) => ({ name, title, description, annotations, input })),
    instructions: body.instructions ?? {}
  };
  listings.set(site.id, { at: Date.now(), plugins });
  return plugins;
}

function isToolResult(value: object): value is ToolResult {
  return "content" in value;
}

/** The site an agent named and the sign-in to reach it with, or the tool error saying why not. */
async function target(env: Env, grant: GrantRow, siteId: unknown): Promise<{ site: PanelSite, session: SessionRow } | ToolResult> {
  if(typeof siteId !== "string" || !siteId) return errorResult({ code: "BAD_REQUEST", message: "site: pass a site's id from sites_list" });
  const site = await siteById(env, siteId);
  const visible = await visibleForGrant(env, grant);
  if(!site || (visible !== "all" && !visible.has(site.id))) return errorResult({ code: "NOT_FOUND", message: `No site "${siteId}" in this panel. sites_list lists them.` });
  const [session] = await db(env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
  if(!session) return errorResult({ code: "UNAUTHORIZED", message: "This connection's sign-in is gone. Reconnect the agent." });
  return { site, session };
}

/** Runs a call on a site, turning the panel's own failures (the user's sign-in, an unreachable site) into tool errors. */
async function onSite(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    if(!(error instanceof PanelError)) throw error;
    const code = error.status === 401 ? "UNAUTHORIZED" : error.status === 403 ? "FORBIDDEN" : "SERVICE_UNAVAILABLE";
    const message = error.status === 401 ? "Your sign-in with the identity provider expired. Reconnect the agent to the panel." : error.message;
    return errorResult({ code, message });
  }
}

/** The sites the connected user sees on the panel. */
async function visibleForGrant(env: Env, grant: GrantRow): Promise<Set<string> | "all"> {
  const [session] = await db(env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
  if(!session) return new Set();
  return visibleSiteIds(env, await hubAccess(env, session));
}

export async function handleMcp(request: Request, env: Env, grant: GrantRow, version: string): Promise<Response> {
  const readOnly = grant.scope === SCOPE_READ;
  return serveMcp(request, {
    name: "Vibe CMS panel",
    version,
    instructions: INSTRUCTIONS,
    // Read-only connections run plugin actions that say they only read, so they keep site_action_call.
    tools: () => allTools().filter(tool => !readOnly || tool.annotations.readOnlyHint || tool.name === siteActionCall.name),
    async call(name, args) {
      if(name === sitesList.name) {
        const results = await db(env).select({ id: t.sites.id, name: t.sites.name, url: t.sites.url }).from(t.sites).orderBy(t.sites.name);
        const visible = await visibleForGrant(env, grant);
        return textResult({ sites: results.filter(site => visible === "all" || visible.has(site.id)) });
      }
      if(name === sitesAttach.name) {
        if(readOnly) return errorResult({ code: "FORBIDDEN", message: "This agent was connected read-only. Reconnect it to make changes." });
        if(typeof args.link !== "string" || !args.link) return errorResult({ code: "BAD_REQUEST", message: "link: pass the site's claim link, ending in #claim=…" });
        const [session] = await db(env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
        if(!session) return errorResult({ code: "UNAUTHORIZED", message: "This connection's sign-in is gone. Reconnect the agent." });
        try {
          const site = await attachSite(env, await hubAccess(env, session), { link: args.link });
          return textResult({ site: { id: site.id, name: site.name, url: site.url }, template: site.template });
        } catch (error) {
          if(!(error instanceof PanelError)) throw error;
          const code = error.status === 403 ? "FORBIDDEN" : error.status === 400 || error.status === 401 || error.status === 409 || error.status === 422 ? "BAD_REQUEST" : "SERVICE_UNAVAILABLE";
          return errorResult({ code, message: error.message });
        }
      }
      if(name === siteActionsList.name) {
        const found = await target(env, grant, args.site);
        if(isToolResult(found)) return found;
        return onSite(async () => {
          const plugins = await pluginActions(env, grant, found.session, found.site);
          if(isToolResult(plugins)) return plugins;
          return textResult({ site: found.site.id, actions: plugins.actions.filter(action => !readOnly || action.annotations.readOnly), instructions: plugins.instructions });
        });
      }
      if(name === siteActionCall.name) {
        if(typeof args.action !== "string" || !args.action) return errorResult({ code: "BAD_REQUEST", message: "action: pass an action's name from site_actions_list" });
        if(args.input !== undefined && (typeof args.input !== "object" || args.input === null || Array.isArray(args.input))) return errorResult({ code: "BAD_REQUEST", message: "input: pass an object" });
        const found = await target(env, grant, args.site);
        if(isToolResult(found)) return found;
        return onSite(async () => {
          const plugins = await pluginActions(env, grant, found.session, found.site);
          if(isToolResult(plugins)) return plugins;
          // Only what the site offers agents: an action marked `mcp: false` is for REST and the CLI.
          const action = plugins.actions.find(candidate => candidate.name === args.action);
          if(!action) return errorResult({ code: "NOT_FOUND", message: `No agent action "${args.action}" on this site. site_actions_list shows what it has.` });
          if(readOnly && !action.annotations.readOnly) return errorResult({ code: "FORBIDDEN", message: "This agent was connected read-only. Reconnect it to make changes." });
          return forward(env, grant, found.session, found.site, action.name, (args.input ?? {}) as Record<string, unknown>);
        });
      }
      const action = actions.get(name);
      if(!action) return null;
      if(readOnly && !action.annotations.readOnly) {
        return errorResult({ code: "FORBIDDEN", message: "This agent was connected read-only. Reconnect it to make changes." });
      }
      const { site: siteId, ...input } = args;
      const found = await target(env, grant, siteId);
      if(isToolResult(found)) return found;
      return onSite(() => forward(env, grant, found.session, found.site, action.name, input));
    }
  });
}
