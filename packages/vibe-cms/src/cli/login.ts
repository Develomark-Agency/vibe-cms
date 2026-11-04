import { Hono } from "hono";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { styleText } from "node:util";
import { command, flag, option, optional, positional, string } from "cmd-ts";
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

interface Authorized {
  clientId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: number
}

/**
 * The browser half of a login: the server's consent page, then back to a loopback address with a code.
 * With `headless`, the server shows the code on a page of its own instead, to paste in here.
 */
async function authorize(server: string, meta: ServerMetadata, clientName: string, headless?: { redirectUri: string }): Promise<Authorized> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));

  let settle!: { resolve: (code: string) => void, reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => (settle = { resolve, reject }));
  const callback = new Hono();
  callback.get("/callback", c => {
    const params = new URL(c.req.url).searchParams;
    if(params.get("state") !== state) return page("This sign-in link is out of date. Run vibe-cms login again.", 400);
    if(params.get("error")) {
      settle.reject(new Error(params.get("error_description") ?? params.get("error")!));
      return page("Not logged in. You can close this tab.");
    }
    settle.resolve(params.get("code") ?? "");
    return page("Logged in. You can close this tab and go back to the terminal.");
  });
  callback.notFound(() => new Response("Not found", { status: 404 }));
  const loopback = headless ? null : Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: callback.fetch });
  const redirectUri = headless?.redirectUri ?? `http://127.0.0.1:${loopback!.port}/callback`;
  try {
    const registered = await fetch(meta.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"]
      })
    });
    const { client_id: clientId } = await registered.json().catch(() => ({})) as { client_id?: string };
    if(!registered.ok || !clientId) throw new Error(`${server} refused to register the CLI (${registered.status})`);

    const target = new URL(meta.authorization_endpoint);
    for(const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope: "content" })) {
      target.searchParams.set(key, value);
    }
    if(headless) {
      console.log(`\n  Open this link in a browser, sign in, and approve the CLI:\n  ${styleText("cyan", target.toString())}\n`);
      void pasteCode(state).then(settle.resolve, settle.reject);
    } else {
      console.log(`\n  Opening ${styleText("cyan", server)} to log in. If no browser opens, visit:\n  ${styleText("dim", target.toString())}\n`);
      openBrowser(target.toString());
    }

    const timeout = setTimeout(() => settle.reject(new Error("Timed out waiting for the browser")), 10 * 60_000);
    const tokens = await tokenRequest(meta.token_endpoint, { grant_type: "authorization_code", code: await code, redirect_uri: redirectUri, code_verifier: verifier, client_id: clientId })
      .finally(() => clearTimeout(timeout));
    return { clientId, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
  } finally {
    loopback?.stop(true);
  }
}

/** Reads the code the site's page showed: `<code>.<state>`, so a code from another login is refused. */
async function pasteCode(state: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const pasted = (await rl.question("  Paste the code here: ")).trim();
    const dot = pasted.lastIndexOf(".");
    if(dot < 0 || pasted.slice(dot + 1) !== state) throw new Error("That code isn't from this login. Run the command again.");
    return pasted.slice(0, dot);
  } finally {
    rl.close();
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

// --- Sites that sign people in themselves ---------------------------------------------------

interface SiteLogin extends Authorized {
  site: string,
  prefix: string
}

function siteKey(site: string, prefix: string): string {
  return `site:${new URL(site).origin}${prefix}`;
}

async function siteMetadata(site: string, prefix: string): Promise<ServerMetadata | null> {
  const response = await fetch(`${new URL(site).origin}${prefix}/.well-known/oauth-authorization-server`).catch(() => null);
  return response?.ok ? await response.json() as ServerMetadata : null;
}

/** Logs in to a site without an org: its editor signs you in and asks you to approve the CLI. */
export async function loginToSite(site: string, prefix: string, headless: boolean): Promise<SiteLogin> {
  const origin = new URL(site).origin;
  const meta = await siteMetadata(origin, prefix);
  if(!meta) throw new Error(`${origin} doesn't sign the CLI in by itself. If it belongs to an org, run vibe-cms login <org> instead.`);
  secrets();
  const login: SiteLogin = {
    site: origin,
    prefix,
    ...await authorize(origin, meta, `vibe-cms CLI (${path.basename(projectRoot())})`, headless ? { redirectUri: `${origin}${prefix}/oauth/code` } : undefined)
  };
  await secrets().set({ service: SERVICE, name: siteKey(origin, prefix), value: JSON.stringify(login) });
  return login;
}

/**
 * An access token for a site you logged in to directly, refreshed when it's about to expire; undefined
 * without a login. Site logins belong to the site, not the project, so every project can use them.
 */
export async function siteLoginToken(site: string, prefix: string): Promise<string | undefined> {
  if(typeof Bun === "undefined" || !Bun.secrets) return undefined;
  const key = siteKey(site, prefix);
  const stored = await secrets().get({ service: SERVICE, name: key });
  if(!stored) return undefined;
  const login = JSON.parse(stored) as SiteLogin;
  if(login.expiresAt > Date.now() + 60_000) return login.accessToken;
  const meta = await siteMetadata(login.site, login.prefix);
  if(!meta) throw new Error(`Couldn't reach ${login.site} to renew your login`);
  try {
    const tokens = await tokenRequest(meta.token_endpoint, { grant_type: "refresh_token", refresh_token: login.refreshToken, client_id: login.clientId });
    const next = { ...login, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 };
    await secrets().set({ service: SERVICE, name: key, value: JSON.stringify(next) });
    return next.accessToken;
  } catch {
    await secrets().delete({ service: SERVICE, name: key });
    throw new Error(`Your login to ${login.site} expired or was disconnected. Run vibe-cms login --site ${login.site} again.`);
  }
}

/**
 * When a command runs against a site you aren't logged in to, and you're at a terminal: log in now, if
 * the site signs the CLI in itself. Undefined when it doesn't, or nobody's there to approve.
 */
export async function loginIfInteractive(site: string, prefix: string): Promise<string | undefined> {
  if(!process.stdin.isTTY || typeof Bun === "undefined" || !Bun.secrets) return undefined;
  if(!await siteMetadata(site, prefix)) return undefined;
  console.error(styleText("dim", `  Not logged in to ${new URL(site).origin}.`));
  return (await loginToSite(site, prefix, false)).accessToken;
}

export const loginCommand = command({
  name: "login",
  description: "Log in to your org's hub (for this project), or to one site that signs people in itself",
  args: {
    org: positional({ type: optional(string), displayName: "org", description: "Your org's domain (its VIBE_ORG), e.g. my-agency.com, or the hub's URL" }),
    site: option({ long: "site", type: optional(string), description: "Log in to this site instead: one without an org" }),
    prefix: option({ long: "prefix", type: string, defaultValue: () => "/_vibe", defaultValueIsSerializable: true, description: "Path the CMS is mounted at" }),
    headless: flag({ long: "headless", description: "Don't open a browser here: print a link, and paste the code it shows" })
  },
  examples: [
    { description: "Log in, then work on any site in the org", command: "vibe-cms login my-agency.com" },
    { description: "Log in to a hub by its address", command: "vibe-cms login https://edit.my-agency.com" },
    { description: "Log in to a site without an org", command: "vibe-cms login --site https://client.com" },
    { description: "…from a machine without a browser", command: "vibe-cms login --site https://client.com --headless" }
  ],
  handler: args => reportErrors(() => runLogin(args))
});

/** Problems the user can act on print as one line, not a stack trace. */
async function reportErrors(task: () => Promise<void>) {
  try {
    await task();
  } catch (error) {
    console.error(`${styleText("red", "✗")} ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

async function runLogin({ org: value, site, prefix, headless }: { org?: string, site?: string, prefix: string, headless: boolean }) {
  {
    if(site) {
      if(!URL.canParse(site)) throw new Error(`Expected a URL like https://client.com, got "${site}"`);
      const login = await loginToSite(site, prefix, headless);
      console.log(`  ${styleText("green", "✓")} ${styleText("bold", "Logged in")} to ${styleText("cyan", login.site)}\n`);
      return;
    }
    if(!value) throw new Error("Name your org (vibe-cms login my-agency.com), or a site with --site");
    const org = normalizeOrg(value);
    if(!org) throw new Error(`Expected a domain like my-agency.com or a URL, got "${value}"`);
    const origin = await resolveHub(org);
    const root = projectRoot();
    secrets();
    const meta = await metadata(origin);
    const login = {
      hub: origin,
      ...await authorize(origin, meta, `vibe-cms CLI (${path.basename(root)})`, headless ? { redirectUri: `${origin}/oauth/code` } : undefined),
      ...(org === origin ? {} : { org })
    };
    await saveLogin(root, login);
    console.log(`  ${styleText("green", "✓")} ${styleText("bold", "Logged in")} to ${styleText("cyan", origin)} for ${styleText("dim", root)}\n`);
  }
}

export const logoutCommand = command({
  name: "logout",
  description: "Log out of this project's hub, or of one site with --site, and revoke the login there",
  args: {
    site: option({ long: "site", type: optional(string), description: "Log out of this site instead" }),
    prefix: option({ long: "prefix", type: string, defaultValue: () => "/_vibe", defaultValueIsSerializable: true, description: "Path the CMS is mounted at" })
  },
  async handler({ site, prefix }) {
    if(site) {
      const key = siteKey(site, prefix);
      const stored = await secrets().get({ service: SERVICE, name: key });
      if(!stored) {
        console.log(`  Not logged in to ${new URL(site).origin}`);
        return;
      }
      const login = JSON.parse(stored) as SiteLogin;
      const meta = await siteMetadata(login.site, login.prefix);
      const revoked = meta?.revocation_endpoint
        ? await fetch(meta.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: login.refreshToken, client_id: login.clientId }) }).then(r => r.ok, () => false)
        : false;
      await secrets().delete({ service: SERVICE, name: key });
      console.log(`  ${styleText("green", "✓")} ${styleText("bold", "Logged out")} of ${styleText("cyan", login.site)}`);
      if(!revoked) console.log(styleText("yellow", `  Couldn't revoke the login at ${login.site}. Disconnect it under Connected apps in the site's editor.`));
      return;
    }
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
