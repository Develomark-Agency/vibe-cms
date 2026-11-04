import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import { command, positional, string } from "cmd-ts";
import { normalizeOrg, resolveHub } from "../org/index.ts";

/**
 * `vibe-cms login <hub>` and `vibe-cms logout`: the CLI as an OAuth client of the agency hub,
 * like an agent. A login belongs to one project (the nearest folder with a vibe-cms config)
 * and lives in the OS keychain, never in a file that could be committed. Commands then ask
 * the hub for a session on whichever site they're run against.
 */

const SERVICE = "vibe-cms";
const CONFIG_FILES = ["vibe-cms.config.ts", "vibe-cms.config.mts", "vibe-cms.config.js", "vibe-cms.config.mjs"];

interface Login {
  hub: string,
  /** The org logged in to, when given as a domain: its hub is looked up again on each use, so it can move. */
  org?: string,
  clientId: string,
  accessToken: string,
  refreshToken: string,
  /** Milliseconds since the epoch. */
  expiresAt: number
}

interface ServerMetadata {
  authorization_endpoint: string,
  token_endpoint: string,
  registration_endpoint: string,
  revocation_endpoint?: string
}

interface TokenResponse {
  access_token: string,
  refresh_token: string,
  expires_in: number
}

/** The folder a login belongs to: the nearest with a vibe-cms config, else the current one. */
export function projectRoot(from = process.cwd()): string {
  for(let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    if(CONFIG_FILES.some(file => existsSync(path.join(dir, file)))) return dir;
    if(path.dirname(dir) === dir) return path.resolve(from);
  }
}

function secrets() {
  if(typeof Bun === "undefined" || !Bun.secrets) throw new Error("Logging in needs Bun 1.3 or later, which keeps logins in the OS keychain. Run the CLI with bunx.");
  return Bun.secrets;
}

async function readLogin(root: string): Promise<Login | null> {
  const stored = await secrets().get({ service: SERVICE, name: root });
  if(!stored) return null;
  const login = JSON.parse(stored) as Login;
  // The org's DNS record says where its hub is now; the stored address is the fallback.
  if(login.org) login.hub = await resolveHub(login.org).catch(() => login.hub);
  return login;
}

function saveLogin(root: string, login: Login): Promise<void> {
  return secrets().set({ service: SERVICE, name: root, value: JSON.stringify(login) });
}

async function metadata(hub: string): Promise<ServerMetadata> {
  const response = await fetch(`${hub}/.well-known/oauth-authorization-server`).catch(() => null);
  if(!response?.ok) throw new Error(`${hub} isn't a vibe-cms hub (no /.well-known/oauth-authorization-server)`);
  return await response.json() as ServerMetadata;
}

async function tokenRequest(endpoint: string, form: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const data = await response.json().catch(() => ({})) as Partial<TokenResponse> & { error_description?: string };
  if(!response.ok || !data.access_token || !data.refresh_token) throw new Error(data.error_description ?? `The hub answered ${response.status}`);
  return data as TokenResponse;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function openBrowser(url: string) {
  const [cmd, ...args] = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  spawn(cmd!, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function page(message: string, status = 200): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>vibe-cms</title><body style="font:15px system-ui;display:grid;place-items:center;min-height:90vh"><p>${message}</p></body>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** The browser half of the login: the hub's consent page, then back to a loopback address with a code. */
async function authorize(hub: string, meta: ServerMetadata, root: string): Promise<Login> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  let settle!: { resolve: (code: string) => void, reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if(url.pathname !== "/callback") return new Response("Not found", { status: 404 });
      const params = url.searchParams;
      if(params.get("state") !== state) return page("This sign-in link is out of date. Run vibe-cms login again.", 400);
      if(params.get("error")) {
        settle.reject(new Error(params.get("error_description") ?? params.get("error")!));
        return page("Not logged in. You can close this tab.");
      }
      settle.resolve(params.get("code") ?? "");
      return page("Logged in. You can close this tab and go back to the terminal.");
    }
  });
  const redirectUri = `http://127.0.0.1:${server.port}/callback`;
  try {
    const registered = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: `vibe-cms CLI (${path.basename(root)})`,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      })
    });
    const { client_id: clientId } = await registered.json().catch(() => ({})) as { client_id?: string };
    if(!registered.ok || !clientId) throw new Error(`The hub refused to register the CLI (${registered.status})`);

    const target = new URL(meta.authorization_endpoint);
    for(const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope: "content" })) {
      target.searchParams.set(key, value);
    }
    console.log(`\n  Opening ${styleText("cyan", hub)} to log in. If no browser opens, visit:\n  ${styleText("dim", target.toString())}\n`);
    openBrowser(target.toString());

    const timeout = setTimeout(() => settle.reject(new Error("Timed out waiting for the browser")), 5 * 60_000);
    const tokens = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: await code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId })
      .finally(() => clearTimeout(timeout));
    return { hub, clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  } finally {
    server.stop(true);
  }
}

/** An access token for the hub, refreshed (and saved, since refresh tokens rotate) when it's about to expire. */
async function accessToken(root: string, login: Login, force = false): Promise<Login> {
  if(!force && login.expiresAt > Date.now() + 60_000) return login;
  const meta = await metadata(login.hub);
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest(meta.token_endpoint, { grant_type: "refresh_token", refresh_token: login.refreshToken, client_id: login.clientId });
  } catch {
    throw new Error(`Your login to ${login.hub} expired or was revoked. Run vibe-cms login ${login.hub} again.`);
  }
  const next = { ...login, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  await saveLogin(root, next);
  return next;
}

/**
 * A session on `site` from this project's hub login, or undefined when there's no login.
 * Throws with what to do when there is one but the hub refuses.
 */
export async function hubSiteToken(site: string): Promise<string | undefined> {
  if(typeof Bun === "undefined" || !Bun.secrets) return undefined;
  const root = projectRoot();
  let login = await readLogin(root);
  if(!login) return undefined;
  for(const retry of [false, true]) {
    login = await accessToken(root, login, retry);
    const response = await fetch(`${login.hub}/site-token`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${login.accessToken}` },
      body: JSON.stringify({ site })
    }).catch(() => null);
    if(!response) throw new Error(`Couldn't reach ${login.hub}`);
    if(response.status === 401 && !retry) continue;
    const data = await response.json().catch(() => ({})) as { token?: string, error?: string };
    if(response.ok && data.token) return data.token;
    throw new Error(data.error ?? `${login.hub} answered ${response.status}`);
  }
  return undefined;
}

export const loginCommand = command({
  name: "login",
  description: "Log in to your agency's hub (panel), for this project",
  args: {
    org: positional({ type: string, displayName: "org", description: "Your org's domain (its VIBE_ORG), e.g. my-agency.com, or the hub's URL" })
  },
  examples: [
    { description: "Log in, then work on any site in the org", command: "vibe-cms login my-agency.com" },
    { description: "Log in to a hub by its address", command: "vibe-cms login https://edit.my-agency.com" }
  ],
  async handler({ org: value }) {
    const org = normalizeOrg(value);
    if(!org) throw new Error(`Expected a domain like my-agency.com or a URL, got "${value}"`);
    const origin = await resolveHub(org);
    const root = projectRoot();
    secrets();
    const login = { ...await authorize(origin, await metadata(origin), root), ...(org === origin ? {} : { org }) };
    await saveLogin(root, login);
    console.log(`  ${styleText("green", "✓")} ${styleText("bold", "Logged in")} to ${styleText("cyan", origin)} for ${styleText("dim", root)}\n`);
  }
});

export const logoutCommand = command({
  name: "logout",
  description: "Log this project out of its hub, and revoke the login there",
  args: {},
  async handler() {
    const root = projectRoot();
    const login = await readLogin(root);
    if(!login) {
      console.log(`  Not logged in for ${styleText("dim", root)}`);
      return;
    }
    // Revoke first, so a hub that can't be reached doesn't leave a working token behind silently.
    const meta = await metadata(login.hub).catch(() => null);
    const revoked = meta?.revocation_endpoint
      ? await fetch(meta.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: login.refreshToken, client_id: login.clientId }) }).then(r => r.ok, () => false)
      : false;
    await secrets().delete({ service: SERVICE, name: root });
    console.log(`  ${styleText("green", "✓")} ${styleText("bold", "Logged out")} of ${styleText("cyan", login.hub)}`);
    if(!revoked) console.log(styleText("yellow", `  Couldn't revoke the login at ${login.hub}. Remove "vibe-cms CLI" under Connected agents there.`));
  }
});
