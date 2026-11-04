import type { JWTPayload } from "jose";
import { normalizeBranding } from "vibe-cms/panel";
import type { Tokens } from "./oidc.ts";
import { pkceChallenge, randomString } from "./oidc.ts";
import { beginLogin, currentSession, json, LOGIN_COOKIE, setCookie, sha256, type Env } from "./shared.ts";

/**
 * The panel as an OAuth 2.1 authorization server for agents (MCP clients). An
 * agent registers itself, sends the user here to approve it, and gets tokens for
 * the panel's `/mcp`. Approving signs the user in with the identity provider once
 * more, so the agent holds its own provider session: signing out of the panel
 * doesn't disconnect it, and revoking it doesn't sign anyone out.
 */

/** Everything the user can reach. */
export const SCOPE_WRITE = "content";
/** Only tools that read. */
export const SCOPE_READ = "content:read";
const SCOPES = [SCOPE_WRITE, SCOPE_READ];

const ACCESS_TTL = 3600 * 1000;
const REFRESH_TTL = 30 * 24 * 3600 * 1000;
const CODE_TTL = 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;
/** How long an agent's own provider session row lives; the provider's refresh token decides in practice. */
const AGENT_SESSION_TTL = 365 * 24 * 3600 * 1000;

interface ClientRow {
  id: string,
  secret_hash: string | null,
  name: string,
  uri: string | null,
  redirect_uris: string,
  auth_method: "none" | "client_secret_post" | "client_secret_basic",
  created_at: number
}

interface RequestRow {
  id: string,
  client_id: string,
  redirect_uri: string,
  challenge: string,
  state: string | null,
  scope: string,
  user: string,
  expires_at: number
}

export interface GrantRow {
  id: string,
  client_id: string,
  user: string,
  session_id: string,
  scope: string,
  access_hash: string | null,
  access_expires_at: number | null,
  refresh_hash: string | null,
  refresh_expires_at: number | null,
  created_at: number,
  last_used_at: number | null
}

/** Discovery documents and the token endpoint are called from browser-based clients too. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };

export function resourceUrl(url: URL): string {
  return `${url.origin}/mcp`;
}

export function protectedResourceMetadata(env: Env, url: URL): Response {
  return json({
    resource: resourceUrl(url),
    authorization_servers: [url.origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: normalizeBranding({ name: env.PANEL_NAME }).name
  }, { headers: CORS });
}

export function authorizationServerMetadata(url: URL): Response {
  return json({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/oauth/authorize`,
    token_endpoint: `${url.origin}/oauth/token`,
    registration_endpoint: `${url.origin}/oauth/register`,
    revocation_endpoint: `${url.origin}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true
  }, { headers: CORS });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, { status, headers: CORS });
}

/** Loopback over http, https, or an app's own scheme. Never something a browser would run. */
function validRedirect(uri: unknown): uri is string {
  if(typeof uri !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if(parsed.hash) return false;
  if(parsed.protocol === "https:") return true;
  if(parsed.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"].includes(parsed.protocol);
}

/** RFC 7591 dynamic client registration: agents add themselves. */
export async function register(request: Request, env: Env): Promise<Response> {
  let input: Record<string, unknown>;
  try {
    input = await request.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "Expected a JSON body");
  }
  const redirects = input.redirect_uris;
  if(!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10 || !redirects.every(validRedirect)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be https, loopback http, or an app scheme");
  }
  const method = (input.token_endpoint_auth_method ?? "client_secret_basic") as ClientRow["auth_method"];
  if(!["none", "client_secret_post", "client_secret_basic"].includes(method)) {
    return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
  }
  const grants = (input.grant_types ?? ["authorization_code"]) as unknown[];
  if(!Array.isArray(grants) || grants.some(g => g !== "authorization_code" && g !== "refresh_token")) {
    return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
  }
  const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 100) : "An agent";
  const uri = typeof input.client_uri === "string" && input.client_uri.startsWith("https://") ? input.client_uri : null;
  const id = `vpc_${randomString(16)}`;
  const secret = method === "none" ? null : `vps_${randomString(32)}`;
  await env.DB.prepare(
    "INSERT INTO oauth_clients (id, secret_hash, name, uri, redirect_uris, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, secret ? await sha256(secret) : null, name, uri, JSON.stringify(redirects), method, Date.now()).run();
  return json({
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    ...(uri ? { client_uri: uri } : {}),
    redirect_uris: redirects,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  }, { status: 201, headers: CORS });
}

async function client(env: Env, id: string | null): Promise<ClientRow | null> {
  if(!id) return null;
  return env.DB.prepare("SELECT * FROM oauth_clients WHERE id = ?").bind(id).first<ClientRow>();
}

function redirectWith(uri: string, params: Record<string, string | null | undefined>, url: URL): Response {
  const target = new URL(uri);
  for(const [key, value] of Object.entries(params)) if(value) target.searchParams.set(key, value);
  target.searchParams.set("iss", url.origin);
  return new Response(null, { status: 302, headers: { location: target.toString(), "cache-control": "no-store" } });
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
  const q = url.searchParams;
  const found = await client(env, q.get("client_id"));
  if(!found) return page(env, "Unknown agent", "<h1>Unknown agent</h1><p>This agent isn't registered with the panel. Try connecting it again.</p>", 400);
  const redirects = JSON.parse(found.redirect_uris) as string[];
  const redirectUri = q.get("redirect_uri") ?? (redirects.length === 1 ? redirects[0]! : null);
  // Never redirect to an address the agent didn't register: show the problem here instead.
  if(!redirectUri || !redirects.includes(redirectUri)) {
    return page(env, "Wrong return address", "<h1>Can't connect this agent</h1><p>It asked to return to an address it didn't register.</p>", 400);
  }
  const state = q.get("state");
  function back(error: string, description: string) {
    return redirectWith(redirectUri!, { error, error_description: description, state }, url);
  }
  if(q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  const challenge = q.get("code_challenge");
  if(!challenge || q.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required");
  const resource = q.get("resource");
  if(resource && resource.replace(/\/$/, "") !== resourceUrl(url) && resource.replace(/\/$/, "") !== url.origin) {
    return back("invalid_target", `This server only issues tokens for ${resourceUrl(url)}`);
  }

  const session = await currentSession(request, env);
  if(!session) return Response.redirect(`${url.origin}/auth/login?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`, 302);

  const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const readOnlyOnly = requested.length > 0 && requested.every(s => s === SCOPE_READ);
  const id = randomString();
  await env.DB.prepare("DELETE FROM oauth_requests WHERE expires_at < ?").bind(Date.now()).run();
  await env.DB.prepare(
    "INSERT INTO oauth_requests (id, client_id, redirect_uri, challenge, state, scope, user, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, found.id, redirectUri, challenge, state, readOnlyOnly ? SCOPE_READ : SCOPE_WRITE, session.sub, Date.now() + REQUEST_TTL).run();

  const returnsTo = new URL(redirectUri).host || new URL(redirectUri).protocol.replace(/:$/, "");
  const who = escape(session.email ?? session.name ?? "your account");
  return page(env, "Connect an agent", `
<h1>Connect <strong>${escape(found.name)}</strong>?</h1>
<p>It will work on the sites you can open in this panel, as <strong>${who}</strong>, with your permissions on each site.</p>
<ul>
  <li><p>Each site still decides what you may do there.</p></li>
  <li><p>You can disconnect it at any time from the panel.</p></li>
</ul>
<p>Afterwards you'll go back to <strong>${escape(returnsTo)}</strong>.</p>
<form method="post" action="/oauth/authorize">
  <input type="hidden" name="request" value="${escape(id)}">
  <label><input type="checkbox" name="readonly" ${readOnlyOnly ? "checked disabled" : ""}> <span>Read only: let it look, but not change anything</span></label>
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
  const pending = await env.DB.prepare("SELECT * FROM oauth_requests WHERE id = ?").bind(String(form.get("request") ?? "")).first<RequestRow>();
  if(!session || !pending || pending.user !== session.sub || pending.expires_at < Date.now()) {
    return page(env, "Expired", "<h1>This request expired</h1><p>Start connecting the agent again.</p>", 400);
  }
  if(form.get("decision") !== "allow") {
    await env.DB.prepare("DELETE FROM oauth_requests WHERE id = ?").bind(pending.id).run();
    return redirectWith(pending.redirect_uri, { error: "access_denied", error_description: "The user cancelled", state: pending.state }, url);
  }
  if(form.get("readonly") === "on") await env.DB.prepare("UPDATE oauth_requests SET scope = ? WHERE id = ?").bind(SCOPE_READ, pending.id).run();
  return beginLogin(env, url, `oauth:${pending.id}`, session.email ?? undefined);
}

/**
 * The provider sign-in for an approved request came back: the agent gets its own
 * provider session and a code to trade for tokens.
 */
export async function completeAuthorization(env: Env, url: URL, requestId: string, claims: JWTPayload, tokens: Tokens): Promise<Response> {
  const pending = await env.DB.prepare("DELETE FROM oauth_requests WHERE id = ? RETURNING *").bind(requestId).first<RequestRow>();
  const clearLogin = setCookie(url, LOGIN_COOKIE, "", 0);
  if(!pending || pending.expires_at < Date.now()) {
    return withCookie(page(env, "Expired", "<h1>This request expired</h1><p>Start connecting the agent again.</p>", 400), clearLogin);
  }
  // Whoever approved must be whoever signed in for the agent.
  if(`${claims.iss}|${claims.sub}` !== pending.user) {
    return withCookie(redirectWith(pending.redirect_uri, { error: "access_denied", error_description: "Signed in as a different account", state: pending.state }, url), clearLogin);
  }
  const sessionId = randomString();
  const grantId = `vpg_${randomString(16)}`;
  const code = randomString();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM agent_grants WHERE refresh_hash IS NULL AND created_at < ?").bind(now - REQUEST_TTL),
    env.DB.prepare("INSERT INTO sessions (id, sub, email, name, id_token, refresh_token, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
      sessionId,
      pending.user,
      typeof claims.email === "string" ? claims.email : null,
      typeof claims.name === "string" ? claims.name : null,
      tokens.id_token,
      tokens.refresh_token ?? null,
      now + AGENT_SESSION_TTL
    ),
    env.DB.prepare("INSERT INTO agent_grants (id, client_id, user, session_id, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(grantId, pending.client_id, pending.user, sessionId, pending.scope, now),
    env.DB.prepare("INSERT INTO oauth_codes (hash, grant_id, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256(code), grantId, pending.client_id, pending.redirect_uri, pending.challenge, now + CODE_TTL)
  ]);
  return withCookie(redirectWith(pending.redirect_uri, { code, state: pending.state }, url), clearLogin);
}

function withCookie(response: Response, cookie: string): Response {
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, headers });
}

/** Client authentication at the token endpoint, by the method the client registered. */
async function authenticate(request: Request, env: Env, form: URLSearchParams): Promise<ClientRow | null> {
  const header = request.headers.get("authorization");
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  if(header?.startsWith("Basic ")) {
    const [user, pass] = atob(header.slice(6)).split(":").map(decodeURIComponent);
    id = user ?? null;
    secret = pass ?? null;
  }
  const found = await client(env, id);
  if(!found) return null;
  if(found.auth_method === "none") return found;
  if(!secret || !found.secret_hash || (await sha256(secret)) !== found.secret_hash) return null;
  return found;
}

async function issueTokens(env: Env, grant: Pick<GrantRow, "id" | "scope">): Promise<Response> {
  const access = `vpa_${randomString(32)}`;
  const refresh = `vpr_${randomString(32)}`;
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE agent_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ? WHERE id = ?"
  ).bind(await sha256(access), now + ACCESS_TTL, await sha256(refresh), now + REFRESH_TTL, grant.id).run();
  return json({
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TTL / 1000,
    refresh_token: refresh,
    scope: grant.scope
  }, { headers: { ...CORS, pragma: "no-cache" } });
}

/** `POST /oauth/token`: codes and refresh tokens in, access tokens out. Refresh tokens rotate. */
export async function token(request: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const found = await authenticate(request, env, form);
  if(!found) return oauthError("invalid_client", "Unknown client or wrong secret", 401);

  if(form.get("grant_type") === "authorization_code") {
    const code = await env.DB.prepare("DELETE FROM oauth_codes WHERE hash = ? RETURNING *").bind(await sha256(form.get("code") ?? ""))
      .first<{ grant_id: string, client_id: string, redirect_uri: string, challenge: string, expires_at: number }>();
    if(!code || code.expires_at < Date.now() || code.client_id !== found.id) return oauthError("invalid_grant", "Unknown or expired code");
    if(form.get("redirect_uri") && form.get("redirect_uri") !== code.redirect_uri) return oauthError("invalid_grant", "redirect_uri doesn't match");
    const verifier = form.get("code_verifier");
    if(!verifier || (await pkceChallenge(verifier)) !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed");
    const grant = await env.DB.prepare("SELECT * FROM agent_grants WHERE id = ?").bind(code.grant_id).first<GrantRow>();
    if(!grant) return oauthError("invalid_grant", "This connection was revoked");
    return issueTokens(env, grant);
  }

  if(form.get("grant_type") === "refresh_token") {
    const grant = await env.DB.prepare("SELECT * FROM agent_grants WHERE refresh_hash = ?").bind(await sha256(form.get("refresh_token") ?? ""))
      .first<GrantRow>();
    if(!grant || grant.client_id !== found.id || (grant.refresh_expires_at ?? 0) < Date.now()) {
      return oauthError("invalid_grant", "Unknown or expired refresh token");
    }
    return issueTokens(env, grant);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/**
 * `POST /oauth/revoke` (RFC 7009): an access or refresh token in, the whole connection gone.
 * Answers 200 for tokens it doesn't know too, so it can't be used to probe for valid ones.
 */
export async function revoke(request: Request, env: Env): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const found = await authenticate(request, env, form);
  if(!found) return oauthError("invalid_client", "Unknown client or wrong secret", 401);
  const hash = await sha256(form.get("token") ?? "");
  const grant = await env.DB.prepare("SELECT * FROM agent_grants WHERE (access_hash = ? OR refresh_hash = ?) AND client_id = ?")
    .bind(hash, hash, found.id).first<GrantRow>();
  if(grant) await revokeGrant(env, grant);
  return new Response(null, { status: 200, headers: CORS });
}

/** The grant behind an `Authorization: Bearer` access token, if it's still valid. */
export async function grantForRequest(request: Request, env: Env): Promise<GrantRow | null> {
  const header = request.headers.get("authorization");
  if(!header?.startsWith("Bearer ")) return null;
  const grant = await env.DB.prepare("SELECT * FROM agent_grants WHERE access_hash = ?").bind(await sha256(header.slice(7))).first<GrantRow>();
  if(!grant || (grant.access_expires_at ?? 0) < Date.now()) return null;
  return grant;
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS" } });
}

/** Removes a connection and everything the panel holds for it. */
export async function revokeGrant(env: Env, grant: Pick<GrantRow, "id" | "session_id">) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM agent_site_tokens WHERE grant_id = ?").bind(grant.id),
    env.DB.prepare("DELETE FROM oauth_codes WHERE grant_id = ?").bind(grant.id),
    env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(grant.session_id),
    env.DB.prepare("DELETE FROM agent_grants WHERE id = ?").bind(grant.id)
  ]);
}

/** The agents a user has connected, for the panel's "Connected agents" list. */
export async function listAgents(env: Env, user: string) {
  const { results } = await env.DB.prepare(
    `SELECT g.id, g.scope, g.created_at, g.last_used_at, c.name, c.uri, c.redirect_uris FROM agent_grants g
     JOIN oauth_clients c ON c.id = g.client_id
     WHERE g.user = ? AND g.refresh_hash IS NOT NULL ORDER BY g.created_at DESC`
  ).bind(user).all<{ id: string, scope: string, created_at: number, last_used_at: number | null, name: string, uri: string | null, redirect_uris: string }>();
  return results.map(row => ({
    id: row.id,
    name: row.name,
    readOnly: row.scope === SCOPE_READ,
    connectedAt: new Date(row.created_at).toISOString(),
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null
  }));
}
