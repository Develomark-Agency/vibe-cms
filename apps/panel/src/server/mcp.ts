import { actionTools, CONTENT_INSTRUCTIONS, coreActions, errorResult, serveMcp, textResult, toolName, type AnyAction, type McpTool } from "vibe-cms/actions";
import { PanelError, type PanelSite } from "vibe-cms/panel";
import { SCOPE_READ, type GrantRow } from "./oauth.ts";
import { apiBase, codeFor } from "./hub.ts";
import { and, eq } from "drizzle-orm";
import * as t from "./schema.ts";
import { db, siteById, type Env, type SessionRow } from "./shared.ts";

/**
 * The panel's MCP server: the same tools as a site's own, plus `sites_list`, with
 * a `site` argument. Each call goes to that site's actions endpoint with a site
 * session the panel gets for the agent's user, so the site decides what's allowed.
 */

const INSTRUCTIONS = `Content management for the sites in this agency panel. Call sites_list first; every other tool takes the site's id as \`site\`.
Each call runs on that site as the signed-in user, and each site decides what they may do there: a Forbidden error means this user can't, not that the tool is broken. Read-only connections only have read-only tools.

${CONTENT_INSTRUCTIONS}`;

const actions = new Map<string, AnyAction>(Object.values(coreActions).map(action => [toolName(action.name), action as AnyAction]));

const sitesList: McpTool = {
  name: "sites_list",
  title: "List sites",
  description: "The sites in this panel. Pass a site's `id` as `site` to every other tool. Being listed doesn't mean the user may edit it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { title: "List sites", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
};

let siteTools: McpTool[] | undefined;

function allTools(): McpTool[] {
  siteTools ??= actionTools(coreActions, {
    input: schema => ({
      ...schema,
      properties: { site: { type: "string", description: "The site's id, from sites_list" }, ...(schema.properties as object) },
      required: ["site", ...((schema.required as string[] | undefined) ?? [])]
    })
  });
  return [sitesList, ...siteTools];
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

async function forward(env: Env, grant: GrantRow, session: SessionRow, site: PanelSite, action: string, input: Record<string, unknown>) {
  for(const fresh of [false, true]) {
    const token = await siteToken(env, grant, session, site, fresh);
    const response = await fetch(`${apiBase(site)}/api/actions/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(input)
    });
    // The site may have dropped the session (expired, keys rotated): get a new one, once.
    if(response.status === 401 && !fresh) continue;
    const body = await response.json().catch(() => ({ error: `The site answered ${response.status}` })) as Record<string, unknown>;
    if(response.ok) return textResult(body);
    return errorResult({ _tag: (body.tag as never) ?? "Unavailable", message: String(body.error ?? response.statusText), details: body.details });
  }
  return errorResult({ _tag: "Unauthorized", message: "The site keeps refusing this user's session" });
}

export async function handleMcp(request: Request, env: Env, grant: GrantRow, version: string): Promise<Response> {
  const readOnly = grant.scope === SCOPE_READ;
  return serveMcp(request, {
    name: "vibe-cms panel",
    version,
    instructions: INSTRUCTIONS,
    tools: () => allTools().filter(tool => !readOnly || tool.annotations.readOnlyHint),
    async call(name, args) {
      if(name === sitesList.name) {
        const results = await db(env).select({ id: t.sites.id, name: t.sites.name, url: t.sites.url }).from(t.sites).orderBy(t.sites.name);
        return textResult({ sites: results });
      }
      const action = actions.get(name);
      if(!action) return null;
      if(readOnly && !action.annotations.readOnly) {
        return errorResult({ _tag: "Forbidden", message: "This agent was connected read-only. Reconnect it to make changes." });
      }
      const { site: siteId, ...input } = args;
      if(typeof siteId !== "string" || !siteId) return errorResult({ _tag: "InvalidInput", message: "site: pass a site's id from sites_list" });
      const site = await siteById(env, siteId);
      if(!site) return errorResult({ _tag: "NotFound", message: `No site "${siteId}" in this panel. sites_list lists them.` });
      const [session] = await db(env).select().from(t.sessions).where(eq(t.sessions.id, grant.payload));
      if(!session) return errorResult({ _tag: "Unauthorized", message: "This connection's sign-in is gone. Reconnect the agent." });
      try {
        return await forward(env, grant, session, site, action.name, input);
      } catch (error) {
        if(!(error instanceof PanelError)) throw error;
        const tag = error.status === 401 ? "Unauthorized" : error.status === 403 ? "Forbidden" : "Unavailable";
        const message = error.status === 401 ? "Your sign-in with the identity provider expired. Reconnect the agent to the panel." : error.message;
        return errorResult({ _tag: tag, message });
      }
    }
  });
}
