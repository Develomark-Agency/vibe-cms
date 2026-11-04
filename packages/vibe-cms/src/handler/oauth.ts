import { HttpError } from "../config.ts";
import { pkceChallenge, randomString } from "../oidc/index.ts";
import type { Session } from "../server/index.ts";
import { all, first, run, sha256 } from "./db.ts";
import type { EngineState } from "./engine.ts";
import { signInMode, standaloneSession, type Identity } from "./signin.ts";

/**
 * A site without an org as an OAuth 2.1 authorization server, so agents (MCP clients) and the CLI sign
 * in to the site itself, like they sign in to a hub:
 *
 * - An agent finds the site's `/_vibe/api/mcp`, gets a 401 that points at the metadata, registers itself
 *   (RFC 7591), and sends the user to `/_vibe/oauth/authorize`.
 * - That sends the browser to the editor, where the user signs in as usual and approves the connection
 *   (optionally read only). The editor posts the answer, and the browser goes back to the agent with a code.
 * - The agent trades the code (with PKCE) for an access token, which works anywhere a session token does,
 *   and a refresh token, which rotates. Roles are worked out on every use, so changes apply at once.
 *
 * The CLI uses a loopback redirect, or with `--headless`, `/_vibe/oauth/code`: a page that shows the code
 * to paste into the terminal. Sites in an org don't serve any of this: their hub does.
 */

export const SCOPE_WRITE = "content";
export const SCOPE_READ = "content:read";
const SCOPES = [SCOPE_WRITE, SCOPE_READ];

const ACCESS_TTL = 3600 * 1000;
const REFRESH_TTL = 30 * 24 * 3600 * 1000;
const CODE_TTL = 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;
export const ACCESS_PREFIX = "vsa_";

type State = Pick<EngineState, "config" | "db" | "org" | "prefix" | "signIn">;

interface ClientRow {
  id: string,
  secret_hash: string | null,
  name: string,
  redirect_uris: string,
  auth_method: "none" | "client_secret_post" | "client_secret_basic",
  created_at: number
}

interface GrantRow {
  id: string,
  client_id: string,
  sub: string,
  identity: string,
  scope: string,
  access_hash: string | null,
  access_expires_at: number | null,
  refresh_hash: string | null,
  refresh_expires_at: number | null,
  created_at: number,
  last_used_at: number | null
}

/** An authorization in progress, from `/oauth/authorize` to the user's answer in the editor. */
interface PendingRequest {
  kind: "oauth",
  clientId: string,
  redirectUri: string,
  challenge: string,
  state: string | null,
  readOnlyOnly: boolean
}

/** Discovery documents and the token endpoint are called from browser-based clients too. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...CORS, ...init.headers } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, { status });
}

export function issuer(state: State, url: URL): string {
  return `${url.origin}${state.prefix}`;
}

export function resourceUrl(state: State, url: URL): string {
  return `${url.origin}${state.prefix}/api/mcp`;
}

/** Whether this site runs its own OAuth server: only when it signs people in itself. */
export async function servesOAuth(state: State): Promise<boolean> {
  return await signInMode(state) !== "hub";
}

/** Where agents look for the metadata, besides `{prefix}/.well-known/...`. Path-inserted, as RFC 8414 and 9728 describe. */
export function wellKnownPaths(prefix: string) {
  return {
    authorizationServer: [`/.well-known/oauth-authorization-server${prefix}`, `${prefix}/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration${prefix}`],
    protectedResource: [`/.well-known/oauth-protected-resource${prefix}/api/mcp`, `/.well-known/oauth-protected-resource${prefix}`, `${prefix}/.well-known/oauth-protected-resource`]
  };
}

export function protectedResourceMetadata(state: State, url: URL, name: string): Response {
  return json({
    resource: resourceUrl(state, url),
    authorization_servers: [issuer(state, url)],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: name
  });
}

export function authorizationServerMetadata(state: State, url: URL): Response {
  const base = issuer(state, url);
  return json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    authorization_response_iss_parameter_supported: true
  });
}

/** What an agent without a valid token gets from `/api/mcp`: where to find out how to sign in. */
export function unauthorized(state: State, url: URL, invalid: boolean): Response {
  return json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: `Sign in to use ${resourceUrl(state, url)}` } },
    {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${url.origin}${state.prefix}/.well-known/oauth-protected-resource"${invalid ? ", error=\"invalid_token\"" : ""}`,
        "access-control-expose-headers": "www-authenticate"
      }
    }
  );
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS" } });
}

/** Loopback over http, https, or an app's own scheme. Never something a browser would run. */
function validRedirect(uri: unknown): uri is string {
  if(typeof uri !== "string" || !URL.canParse(uri)) return false;
  const parsed = new URL(uri);
  if(parsed.hash) return false;
  if(parsed.protocol === "https:") return true;
  if(parsed.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"].includes(parsed.protocol);
}

/** RFC 7591 dynamic client registration: agents and the CLI add themselves. */
export async function register(state: State, request: Request): Promise<Response> {
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
  if(!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
  const grants = (input.grant_types ?? ["authorization_code"]) as unknown[];
  if(!Array.isArray(grants) || grants.some(g => g !== "authorization_code" && g !== "refresh_token")) {
    return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
  }
  const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 100) : "An agent";
  const id = `vsc_${randomString(16)}`;
  const secret = method === "none" ? null : `vss_${randomString(32)}`;
  await run(state.db, "INSERT INTO vibe_oauth_clients (id, secret_hash, name, redirect_uris, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    id, secret ? await sha256(secret) : null, name, JSON.stringify(redirects), method, Date.now()
  ]);
  return json({
    client_id: id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: redirects,
    token_endpoint_auth_method: method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  }, { status: 201 });
}

function client(state: State, id: string | null): Promise<ClientRow | null> {
  return id ? first<ClientRow>(state.db, "SELECT * FROM vibe_oauth_clients WHERE id = ?", [id]) : Promise.resolve(null);
}

function redirectWith(state: State, url: URL, uri: string, params: Record<string, string | null | undefined>): string {
  const target = new URL(uri);
  for(const [key, value] of Object.entries(params)) if(value) target.searchParams.set(key, value);
  target.searchParams.set("iss", issuer(state, url));
  return target.toString();
}

function plainPage(title: string, message: string, status: number): Response {
  const escaped = message.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:15px/1.5 system-ui;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><main style="max-width:420px"><h1 style="font-size:20px">${title}</h1><p>${escaped}</p></main>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }
  });
}

/**
 * `GET {prefix}/oauth/authorize`: checks the request, keeps it, and sends the browser to the editor to
 * sign in and approve it. Problems with the client or its return address show here, never redirect.
 */
export async function authorize(state: State, url: URL): Promise<Response> {
  const q = url.searchParams;
  const found = await client(state, q.get("client_id"));
  if(!found) return plainPage("Unknown app", "This app isn't registered with the site. Try connecting it again.", 400);
  const redirects = JSON.parse(found.redirect_uris) as string[];
  const redirectUri = q.get("redirect_uri") ?? (redirects.length === 1 ? redirects[0]! : null);
  if(!redirectUri || !redirects.includes(redirectUri)) return plainPage("Can't connect this app", "It asked to return to an address it didn't register.", 400);
  function back(error: string, description: string) {
    return Response.redirect(redirectWith(state, url, redirectUri!, { error, error_description: description, state: q.get("state") }), 302);
  }
  if(q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  const challenge = q.get("code_challenge");
  if(!challenge || q.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required");
  const resource = q.get("resource")?.replace(/\/$/, "");
  if(resource && resource !== resourceUrl(state, url) && resource !== issuer(state, url) && resource !== url.origin) {
    return back("invalid_target", `This site only issues tokens for ${resourceUrl(state, url)}`);
  }
  const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const pending: PendingRequest = {
    kind: "oauth",
    clientId: found.id,
    redirectUri,
    challenge,
    state: q.get("state"),
    readOnlyOnly: requested.length > 0 && requested.every(s => s === SCOPE_READ)
  };
  const id = randomString(16);
  await run(state.db, "DELETE FROM vibe_challenges WHERE expires_at < ?", [Date.now()]);
  await run(state.db, "INSERT INTO vibe_challenges (id, payload, expires_at) VALUES (?, ?, ?)", [id, JSON.stringify(pending), Date.now() + REQUEST_TTL]);
  return new Response(null, { status: 302, headers: { location: `${url.origin}${state.prefix}/admin/#connect=${id}`, "cache-control": "no-store" } });
}

async function pendingRequest(state: State, id: unknown): Promise<PendingRequest | null> {
  if(typeof id !== "string") return null;
  const row = await first<{ payload: string, expires_at: number }>(state.db, "SELECT payload, expires_at FROM vibe_challenges WHERE id = ?", [id]);
  if(!row || row.expires_at < Date.now()) return null;
  const pending = JSON.parse(row.payload) as PendingRequest;
  return pending.kind === "oauth" ? pending : null;
}

/** What the editor shows when asking the signed-in user to approve. */
export async function describeRequest(state: State, id: unknown) {
  const pending = await pendingRequest(state, id);
  if(!pending) throw new HttpError(404, "This connection request expired. Start connecting the app again.");
  const found = await client(state, pending.clientId);
  if(!found) throw new HttpError(404, "This app isn't registered any more");
  const target = new URL(pending.redirectUri);
  return {
    client: found.name,
    returnsTo: target.host || target.protocol.replace(/:$/, ""),
    // A headless CLI login shows its code on the site itself.
    showsCode: target.pathname === `${state.prefix}/oauth/code`,
    readOnlyOnly: pending.readOnlyOnly
  };
}

/**
 * The signed-in user's answer, posted by the editor. The connection acts as whoever approved it, as they
 * signed in (the browser's sign-in), and returns where the browser goes next.
 */
export async function decide(state: State, url: URL, session: Session, identity: Identity | null, input: { request?: unknown, allow?: unknown, readOnly?: unknown }) {
  const pending = await pendingRequest(state, input.request);
  if(!pending) throw new HttpError(404, "This connection request expired. Start connecting the app again.");
  await run(state.db, "DELETE FROM vibe_challenges WHERE id = ?", [input.request]);
  if(input.allow !== true) {
    return { redirect: redirectWith(state, url, pending.redirectUri, { error: "access_denied", error_description: "The user cancelled", state: pending.state }) };
  }
  if(!identity || identity.sub !== session.sub) throw new HttpError(403, "Sign in on this site to connect apps");
  const scope = pending.readOnlyOnly || input.readOnly === true ? SCOPE_READ : SCOPE_WRITE;
  const grantId = `vsg_${randomString(16)}`;
  const code = randomString(32);
  const now = Date.now();
  await state.db.batch([
    state.db.prepare("DELETE FROM vibe_oauth_grants WHERE refresh_hash IS NULL AND created_at < ?").bind(now - REQUEST_TTL),
    state.db.prepare("INSERT INTO vibe_oauth_grants (id, client_id, sub, identity, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(grantId, pending.clientId, identity.sub, JSON.stringify(identity), scope, now),
    state.db.prepare("INSERT INTO vibe_oauth_codes (hash, grant_id, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(await sha256(code), grantId, pending.clientId, pending.redirectUri, pending.challenge, now + CODE_TTL)
  ]);
  return { redirect: redirectWith(state, url, pending.redirectUri, { code, state: pending.state }) };
}

/** Client authentication at the token endpoint, by the method the client registered. */
async function authenticate(state: State, request: Request, form: URLSearchParams): Promise<ClientRow | null> {
  const header = request.headers.get("authorization");
  let id = form.get("client_id");
  let secret = form.get("client_secret");
  if(header?.startsWith("Basic ")) {
    const [user, pass] = atob(header.slice(6)).split(":").map(decodeURIComponent);
    id = user ?? null;
    secret = pass ?? null;
  }
  const found = await client(state, id);
  if(!found) return null;
  if(found.auth_method === "none") return found;
  if(!secret || !found.secret_hash || (await sha256(secret)) !== found.secret_hash) return null;
  return found;
}

async function issueTokens(state: State, grant: Pick<GrantRow, "id" | "scope">): Promise<Response> {
  const access = `${ACCESS_PREFIX}${randomString(32)}`;
  const refresh = `vsr_${randomString(32)}`;
  const now = Date.now();
  await run(state.db, "UPDATE vibe_oauth_grants SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ? WHERE id = ?", [
    await sha256(access), now + ACCESS_TTL, await sha256(refresh), now + REFRESH_TTL, grant.id
  ]);
  return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: grant.scope }, { headers: { pragma: "no-cache" } });
}

/** `POST {prefix}/oauth/token`: codes and refresh tokens in, access tokens out. Refresh tokens rotate. */
export async function token(state: State, request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const found = await authenticate(state, request, form);
  if(!found) return oauthError("invalid_client", "Unknown client or wrong secret", 401);
  if(form.get("grant_type") === "authorization_code") {
    const code = await first<{ grant_id: string, client_id: string, redirect_uri: string, challenge: string, expires_at: number }>(
      state.db,
      "DELETE FROM vibe_oauth_codes WHERE hash = ? RETURNING *",
      [await sha256(form.get("code") ?? "")]
    );
    if(!code || code.expires_at < Date.now() || code.client_id !== found.id) return oauthError("invalid_grant", "Unknown or expired code");
    if(form.get("redirect_uri") && form.get("redirect_uri") !== code.redirect_uri) return oauthError("invalid_grant", "redirect_uri doesn't match");
    const verifier = form.get("code_verifier");
    if(!verifier || (await pkceChallenge(verifier)) !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed");
    const grant = await first<GrantRow>(state.db, "SELECT * FROM vibe_oauth_grants WHERE id = ?", [code.grant_id]);
    if(!grant) return oauthError("invalid_grant", "This connection was removed");
    return issueTokens(state, grant);
  }
  if(form.get("grant_type") === "refresh_token") {
    const grant = await first<GrantRow>(state.db, "SELECT * FROM vibe_oauth_grants WHERE refresh_hash = ?", [await sha256(form.get("refresh_token") ?? "")]);
    if(!grant || grant.client_id !== found.id || (grant.refresh_expires_at ?? 0) < Date.now()) return oauthError("invalid_grant", "Unknown or expired refresh token");
    return issueTokens(state, grant);
  }
  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
}

/** `POST {prefix}/oauth/revoke` (RFC 7009). Answers 200 for unknown tokens too, so it can't probe for valid ones. */
export async function revoke(state: State, request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const found = await authenticate(state, request, form);
  if(!found) return oauthError("invalid_client", "Unknown client or wrong secret", 401);
  const hash = await sha256(form.get("token") ?? "");
  const grant = await first<GrantRow>(state.db, "SELECT * FROM vibe_oauth_grants WHERE (access_hash = ? OR refresh_hash = ?) AND client_id = ?", [hash, hash, found.id]);
  if(grant) await removeGrant(state, grant.id);
  return new Response(null, { status: 200, headers: CORS });
}

/**
 * The session behind an access token: whoever approved the connection, with their roles now, held to
 * reading for a read-only connection. Null when it isn't one of this site's access tokens, or expired.
 */
export async function grantSession(state: State, accessToken: string): Promise<Session | null> {
  if(!accessToken.startsWith(ACCESS_PREFIX)) return null;
  const grant = await first<GrantRow>(state.db, "SELECT * FROM vibe_oauth_grants WHERE access_hash = ?", [await sha256(accessToken)]);
  if(!grant || (grant.access_expires_at ?? 0) < Date.now()) return null;
  // A site that joined an org since stops taking its own tokens.
  if(!await servesOAuth(state)) return null;
  const session = await standaloneSession(state, JSON.parse(grant.identity) as Identity);
  if(!grant.last_used_at || grant.last_used_at < Date.now() - 60_000) await run(state.db, "UPDATE vibe_oauth_grants SET last_used_at = ? WHERE id = ?", [Date.now(), grant.id]);
  return grant.scope === SCOPE_READ ? { ...session, readOnly: true } : session;
}

async function removeGrant(state: State, id: string) {
  await state.db.batch([
    state.db.prepare("DELETE FROM vibe_oauth_codes WHERE grant_id = ?").bind(id),
    state.db.prepare("DELETE FROM vibe_oauth_grants WHERE id = ?").bind(id)
  ]);
}

/** The apps a user connected, for the editor's list. */
export async function listGrants(state: State, sub: string) {
  const rows = await all<{ id: string, scope: string, created_at: number, last_used_at: number | null, name: string }>(
    state.db,
    `SELECT g.id, g.scope, g.created_at, g.last_used_at, c.name FROM vibe_oauth_grants g
     JOIN vibe_oauth_clients c ON c.id = g.client_id
     WHERE g.sub = ? AND g.refresh_hash IS NOT NULL ORDER BY g.created_at DESC`,
    [sub]
  );
  return rows.map(row => ({ id: row.id, name: row.name, readOnly: row.scope === SCOPE_READ, connectedAt: row.created_at, lastUsedAt: row.last_used_at }));
}

export async function disconnect(state: State, sub: string, id: string) {
  const grant = await first<GrantRow>(state.db, "SELECT * FROM vibe_oauth_grants WHERE id = ? AND sub = ?", [id, sub]);
  if(!grant) throw new HttpError(404, "No such connection");
  await removeGrant(state, id);
}

/** `GET {prefix}/oauth/code`: where a headless CLI login lands, showing the code to paste into the terminal. */
export function codePage(url: URL): Response {
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const state = url.searchParams.get("state") ?? "";
  if(!code) return plainPage("Not connected", error ?? "No code here.", 400);
  // The state rides along, so the CLI can check the pasted code is the one it asked for.
  const value = `${code}.${state}`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Your code</title>
<body style="font:15px/1.5 system-ui;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><main style="max-width:480px;text-align:center">
<h1 style="font-size:20px">Paste this code in your terminal</h1>
<p><code id="code" style="display:block;word-break:break-all;font-size:14px;padding:12px;border:1px solid #8884;border-radius:10px;user-select:all">${value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)}</code></p>
<button onclick="navigator.clipboard.writeText(document.getElementById('code').textContent);this.textContent='Copied'" style="font:inherit;padding:8px 16px;border-radius:10px;border:1px solid #8884;background:none;color:inherit;cursor:pointer">Copy</button>
<p style="opacity:.7">It works once, for a minute.</p></main>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" }
  });
}
