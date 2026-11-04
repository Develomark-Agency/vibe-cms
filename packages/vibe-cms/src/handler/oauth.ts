import { HttpError } from "../config.ts";
import { createDb } from "../db/client.ts";
import { oauthClients, oauthCodes, oauthGrants, oauthRequests } from "../db/schema.ts";
import { OAuthServer, SCOPE_READ } from "../oauth/index.ts";
import type { Session } from "../server/index.ts";
import type { EngineState } from "./engine.ts";
import { signInMode, standaloneSession, type Identity } from "./signin.ts";

export { codePage, corsPreflight } from "../oauth/index.ts";

/**
 * A site without an org as an OAuth server (vibe-cms/oauth), so agents and the CLI sign in to the site
 * itself, like they sign in to a hub:
 *
 * - An agent finds `{prefix}/api/mcp`, gets a 401 that points at the metadata, registers itself, and sends
 *   the user to `{prefix}/oauth/authorize`.
 * - That sends the browser to the editor (`#connect=<request>`), where the user signs in as usual and
 *   approves the connection, optionally read only.
 * - The connection carries the approver's identity, as they signed in. Its access tokens work anywhere a
 *   session token does, with roles worked out on every use.
 *
 * Sites in an org don't serve any of this: their hub does.
 */

type State = Pick<EngineState, "config" | "db" | "org" | "prefix" | "signIn">;

const servers = new WeakMap<object, OAuthServer>();

function server(state: State): OAuthServer {
  let found = servers.get(state.db);
  if(!found) {
    found = new OAuthServer({
      db: createDb(state.db),
      tables: { clients: oauthClients, requests: oauthRequests, codes: oauthCodes, grants: oauthGrants },
      tokens: "vs",
      issuer: url => `${url.origin}${state.prefix}`,
      resource: url => `${url.origin}${state.prefix}/api/mcp`,
      resourceMetadata: url => `${url.origin}${state.prefix}/.well-known/oauth-protected-resource`
    });
    servers.set(state.db, found);
  }
  return found;
}

/** Whether this site runs its own OAuth server: only when it signs people in itself. */
export async function servesOAuth(state: State): Promise<boolean> {
  return await signInMode(state) !== "hub";
}

/** Where agents look for the metadata: path-inserted (RFC 8414, RFC 9728), and under the prefix. */
export function wellKnownPaths(prefix: string) {
  return {
    authorizationServer: [`/.well-known/oauth-authorization-server${prefix}`, `${prefix}/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration${prefix}`],
    protectedResource: [`/.well-known/oauth-protected-resource${prefix}/api/mcp`, `/.well-known/oauth-protected-resource${prefix}`, `${prefix}/.well-known/oauth-protected-resource`]
  };
}

export function authorizationServerMetadata(state: State, url: URL) {
  return server(state).authorizationServerMetadata(url);
}
export function protectedResourceMetadata(state: State, url: URL, name: string) {
  return server(state).protectedResourceMetadata(url, name);
}
export function unauthorized(state: State, url: URL, invalid: boolean) {
  return server(state).unauthorized(url, invalid);
}
export function register(state: State, request: Request) {
  return server(state).register(request);
}
export function token(state: State, request: Request) {
  return server(state).token(request);
}
export function revoke(state: State, request: Request) {
  return server(state).revoke(request);
}

function plainPage(title: string, message: string, status: number): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><body style="font:15px/1.5 system-ui;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><main style="max-width:420px"><h1 style="font-size:20px">${title}</h1><p>${message}</p></main>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" }
  });
}

/** `GET {prefix}/oauth/authorize`: checks the request, keeps it, and sends the browser to the editor to sign in and approve it. */
export async function authorize(state: State, url: URL): Promise<Response> {
  const checked = await server(state).validate(url);
  if("problem" in checked) {
    return checked.problem === "unknown-client"
      ? plainPage("Unknown app", "This app isn't registered with the site. Try connecting it again.", 400)
      : plainPage("Can't connect this app", "It asked to return to an address it didn't register.", 400);
  }
  if("response" in checked) return checked.response;
  const id = await server(state).saveRequest(checked);
  return new Response(null, { status: 302, headers: { location: `${url.origin}${state.prefix}/admin/#connect=${id}`, "cache-control": "no-store" } });
}

/** What the editor shows when asking the signed-in user to approve. */
export async function describeRequest(state: State, id: unknown) {
  const found = await server(state).pending(id);
  if(!found) throw new HttpError(404, "This connection request expired. Start connecting the app again.");
  const target = new URL(found.request.redirect_uri);
  return {
    client: found.client.name,
    returnsTo: target.host || target.protocol.replace(/:$/, ""),
    // A headless CLI login shows its code on the site itself.
    showsCode: target.pathname === `${state.prefix}/oauth/code`,
    readOnlyOnly: found.request.scope === SCOPE_READ
  };
}

/**
 * The signed-in user's answer, posted by the editor. The connection acts as whoever approved it, as they
 * signed in (the browser's sign-in); returns where the browser goes next.
 */
export async function decide(state: State, url: URL, session: Session, identity: Identity | null, input: { request?: unknown, allow?: unknown, readOnly?: unknown }) {
  const oauth = server(state);
  if(!await oauth.pending(input.request)) throw new HttpError(404, "This connection request expired. Start connecting the app again.");
  const id = input.request as string;
  if(input.allow !== true) return { redirect: (await oauth.deny(url, id))! };
  if(!identity || identity.sub !== session.sub) throw new HttpError(403, "Sign in on this site to connect apps");
  const redirect = await oauth.approve(url, id, { user: identity.sub, payload: JSON.stringify(identity), readOnly: input.readOnly === true });
  if(!redirect) throw new HttpError(404, "This connection request expired. Start connecting the app again.");
  return { redirect };
}

/**
 * The session behind an access token: whoever approved the connection, with their roles now, held to
 * reading for a read-only connection. Null when it isn't one of this site's access tokens, or expired.
 */
export async function grantSession(state: State, accessToken: string): Promise<Session | null> {
  const grant = await server(state).grantFor(accessToken);
  // A site that joined an org since stops taking its own tokens.
  if(!grant || !await servesOAuth(state)) return null;
  const session = await standaloneSession(state, JSON.parse(grant.payload) as Identity);
  return grant.scope === SCOPE_READ ? { ...session, readOnly: true } : session;
}

/** The apps a user connected, for the editor's list. */
export function listGrants(state: State, sub: string) {
  return server(state).list(sub);
}

export async function disconnect(state: State, sub: string, id: string) {
  const grant = await server(state).userGrant(sub, id);
  if(!grant) throw new HttpError(404, "No such connection");
  await server(state).remove(grant);
}
