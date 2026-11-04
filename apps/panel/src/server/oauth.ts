import type { JWTPayload } from "jose";
import { normalizeBranding } from "vibe-cms/panel";
import { OAuthServer, type GrantRow } from "vibe-cms/oauth";
import type { Tokens } from "./oidc.ts";
import { randomString } from "./oidc.ts";
import { beginLogin, currentSession, LOGIN_COOKIE, setCookie, type Env } from "./shared.ts";

export { codePage, corsPreflight, SCOPE_READ, SCOPE_WRITE, type GrantRow } from "vibe-cms/oauth";

/**
 * The panel as an OAuth server for agents and the CLI (vibe-cms/oauth, which sites without an org run too).
 * What's the hub's own: a consent page it renders itself, and approving signs the user in with the
 * identity provider once more, so each connection holds its own provider session (its grant's `payload`
 * is that session's id). Signing out of the panel doesn't disconnect agents, and revoking one doesn't
 * sign anyone out; the hub refreshes that session before vouching for the user to a site.
 */

/** How long an agent's own provider session row lives; the provider's refresh token decides in practice. */
const AGENT_SESSION_TTL = 365 * 24 * 3600 * 1000;

export function resourceUrl(url: URL): string {
  return `${url.origin}/mcp`;
}

const servers = new WeakMap<object, OAuthServer>();

export function oauth(env: Env): OAuthServer {
  let found = servers.get(env.DB);
  if(!found) {
    found = new OAuthServer({
      db: env.DB,
      tables: "",
      tokens: "vp",
      issuer: url => url.origin,
      resource: resourceUrl,
      resourceMetadata: url => `${url.origin}/.well-known/oauth-protected-resource`,
      // A connection's own provider session, and the site sessions held for it.
      onRemove: grant => [
        env.DB.prepare("DELETE FROM agent_site_tokens WHERE grant_id = ?").bind(grant.id),
        env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(grant.payload)
      ]
    });
    servers.set(env.DB, found);
  }
  return found;
}

export function protectedResourceMetadata(env: Env, url: URL): Response {
  return oauth(env).protectedResourceMetadata(url, normalizeBranding({ name: env.PANEL_NAME }).name);
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };

function escape(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!);
}

/** A plain page in the panel's colours, for consent and for errors that can't go back to the agent. */
function page(env: Env, title: string, body: string, status = 200): Response {
  const branding = normalizeBranding({ name: env.PANEL_NAME, accent: env.PANEL_ACCENT, icon: env.PANEL_ICON });
  const accent = branding.accent ?? "#18181b";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · ${escape(branding.name)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f4f4f5; --card: #fff; --text: #18181b; --muted: #71717a; --border: #e4e4e7; --accent: ${accent}; }
  @media (prefers-color-scheme: dark) { :root { --bg: #09090b; --card: #18181b; --text: #fafafa; --muted: #a1a1aa; --border: #27272a; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { margin: 0 0 12px; color: var(--muted); }
  strong { color: var(--text); }
  ul { margin: 0 0 16px; padding-left: 20px; }
  label { display: flex; gap: 8px; align-items: flex-start; margin: 16px 0 20px; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  button { font: inherit; border-radius: 10px; padding: 8px 16px; border: 1px solid var(--border); background: transparent; color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; font-weight: 600; }
  .brand img { width: 24px; height: 24px; border-radius: 6px; }
</style>
</head>
<body><main><div class="brand">${branding.icon ? `<img src="${escape(branding.icon)}" alt="">` : ""}${escape(branding.name)}</div>${body}</main></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" }
  });
}

/** `GET /oauth/authorize`: checks the agent's request, then asks the signed-in user. */
export async function authorize(request: Request, env: Env, url: URL): Promise<Response> {
  const checked = await oauth(env).validate(url);
  if("problem" in checked) {
    return checked.problem === "unknown-client"
      ? page(env, "Unknown agent", "<h1>Unknown agent</h1><p>This agent isn't registered with the panel. Try connecting it again.</p>", 400)
      : page(env, "Wrong return address", "<h1>Can't connect this agent</h1><p>It asked to return to an address it didn't register.</p>", 400);
  }
  if("response" in checked) return checked.response;

  const session = await currentSession(request, env);
  if(!session) return Response.redirect(`${url.origin}/auth/login?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);
  const id = await oauth(env).saveRequest(checked, session.sub);

  const target = new URL(checked.redirectUri);
  const returnsTo = target.pathname === "/oauth/code" && target.origin === url.origin ? "a code to paste into your terminal" : target.host || target.protocol.replace(/:$/, "");
  const who = escape(session.email ?? session.name ?? "your account");
  return page(env, "Connect an agent", `
<h1>Connect <strong>${escape(checked.client.name)}</strong>?</h1>
<p>It will work on the sites you can open in this panel, as <strong>${who}</strong>, with your permissions on each site.</p>
<ul>
  <li><p>Each site still decides what you may do there.</p></li>
  <li><p>You can disconnect it at any time from the panel.</p></li>
</ul>
<p>Afterwards you'll go back to <strong>${escape(returnsTo)}</strong>.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${escape(id)}">
  <label><input type="checkbox" name="readonly" ${checked.readOnlyOnly ? "checked disabled" : ""}> <span>Read only: let it look, but not change anything</span></label>
  <div class="actions">
    <button type="submit" name="decision" value="deny">Cancel</button>
    <button type="submit" name="decision" value="allow" class="primary">Connect</button>
  </div>
</form>`);
}

/** `POST /oauth/authorize`: the user's answer. Approving signs in with the provider for the agent. */
export async function decide(request: Request, env: Env, url: URL): Promise<Response> {
  // The form only posts from the panel's own page.
  if(request.headers.get("origin") !== url.origin) return page(env, "Refused", "<h1>Refused</h1><p>That request didn't come from this panel.</p>", 403);
  const session = await currentSession(request, env);
  const form = await request.formData();
  const id = String(form.get("request") ?? "");
  const pending = await oauth(env).pending(id);
  if(!session || !pending || pending.request.user !== session.sub) {
    return page(env, "Expired", "<h1>This request expired</h1><p>Start connecting the agent again.</p>", 400);
  }
  if(form.get("decision") !== "allow") return Response.redirect((await oauth(env).deny(url, id))!, 302);
  if(form.get("readonly") === "on") await oauth(env).limitToReading(id);
  return beginLogin(env, url, `oauth:${id}`, session.email ?? undefined);
}

/**
 * The provider sign-in for an approved request came back: the agent gets its own provider session,
 * and a code to trade for tokens.
 */
export async function completeAuthorization(env: Env, url: URL, requestId: string, claims: JWTPayload, tokens: Tokens): Promise<Response> {
  const clearLogin = setCookie(url, LOGIN_COOKIE, "", 0);
  const user = `${claims.iss}|${claims.sub}`;
  const pending = await oauth(env).pending(requestId);
  if(!pending) return withCookie(page(env, "Expired", "<h1>This request expired</h1><p>Start connecting the agent again.</p>", 400), clearLogin);
  // Whoever approved must be whoever signed in for the agent; the core refuses anyone else.
  let sessionId = "";
  if(pending.request.user === user) {
    sessionId = randomString();
    await env.DB.prepare("INSERT INTO sessions (id, sub, email, name, id_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      sessionId,
      user,
      typeof claims.email === "string" ? claims.email : null,
      typeof claims.name === "string" ? claims.name : null,
      tokens.id_token,
      tokens.refresh_token ?? null,
      Date.now() + AGENT_SESSION_TTL
    ).run();
  }
  const redirect = await oauth(env).approve(url, requestId, { user, payload: sessionId });
  if(!redirect) return withCookie(page(env, "Expired", "<h1>This request expired</h1><p>Start connecting the agent again.</p>", 400), clearLogin);
  return withCookie(Response.redirect(redirect, 302), clearLogin);
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

/** The grant behind an `Authorization: Bearer` access token, if it's still valid. */
export function grantForRequest(request: Request, env: Env): Promise<GrantRow | null> {
  return oauth(env).grantForRequest(request);
}

/** Removes a connection and everything the panel holds for it. */
export function revokeGrant(env: Env, grant: GrantRow) {
  return oauth(env).remove(grant);
}

/** The agents a user has connected, for the panel's "Connected agents" list. */
export async function listAgents(env: Env, user: string) {
  return (await oauth(env).list(user)).map(agent => ({
    id: agent.id,
    name: agent.name,
    readOnly: agent.readOnly,
    connectedAt: new Date(agent.connectedAt).toISOString(),
    lastUsedAt: agent.lastUsedAt ? new Date(agent.lastUsedAt).toISOString() : null
  }));
}
