import { coreActions } from "../../actions/core.ts";
import { listActions } from "../../actions/define.ts";
import { describeActions, type ActionDescription } from "../../actions/describe.ts";
import { devToken } from "../actions.ts";
import { hubSiteToken, siteLoginToken, siteMetadata } from "../login.ts";

/** The site the TUI works on: its origin and where the CMS is mounted. */
export interface Site {
  url: string,
  prefix: string,
  /** What the site calls itself, when it has a name of its own. */
  name?: string
}

/**
 * The site's name, from the descriptor every site serves publicly at `/.well-known/vibe-cms`. A site
 * nobody has named calls itself by its host, which says nothing the address doesn't.
 */
export async function siteName(site: Site): Promise<string | undefined> {
  const response = await fetch(`${site.url}/.well-known/vibe-cms`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if(!response?.ok) return undefined;
  const descriptor = await response.json().catch(() => null) as { protocol?: number, name?: string | null } | null;
  const name = descriptor?.protocol === 1 ? descriptor.name?.trim() : undefined;
  return name && name !== new URL(site.url).hostname && name !== new URL(site.url).host ? name : undefined;
}

/** How the TUI is signed in to the site, and what it can do about it when it isn't. */
export interface Auth {
  token?: string,
  via: "token" | "dev" | "site login" | "hub" | "none",
  /** Why there's no session, when something refused. */
  problem?: string,
  /** The site signs the CLI in itself, so `vibe-cms login --site` would work. */
  canLogIn: boolean
}

/** `localhost:1337` → `http://localhost:1337`, `client.com/` → `https://client.com`. */
export function normalizeSite(input: string): string | null {
  const text = input.trim();
  if(!text) return null;
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/i.test(text) || /\.(localhost|test)(:\d+)?(\/|$)/i.test(text);
  const url = /^https?:\/\//i.test(text) ? text : `${local ? "http" : "https"}://${text}`;
  if(!URL.canParse(url)) return null;
  return new URL(url).origin;
}

export function normalizePrefix(input: string | undefined): string {
  const text = (input ?? "").trim() || "/_vibe";
  return `/${text.replace(/^\/+|\/+$/g, "")}`;
}

/**
 * A session on the site, the way the CLI gets one (`--token`/`VIBE_TOKEN`, a development sign-in, a site
 * login, this project's hub login), but without logging in at the terminal: the TUI offers that itself.
 */
export async function authorize(site: Site, token = process.env.VIBE_TOKEN): Promise<Auth> {
  async function canLogIn() {
    return Boolean(await siteMetadata(site.url, site.prefix).catch(() => null));
  }
  if(token) return { token, via: "token", canLogIn: false };
  const dev = await devToken(site.url, site.prefix);
  if(dev) return { token: dev, via: "dev", canLogIn: false };
  let problem: string | undefined;
  try {
    const own = await siteLoginToken(site.url, site.prefix);
    if(own) return { token: own, via: "site login", canLogIn: true };
  } catch (error) {
    problem = (error as Error).message;
  }
  try {
    const fromHub = await hubSiteToken(site.url);
    if(fromHub) return { token: fromHub, via: "hub", canLogIn: false };
  } catch (error) {
    problem ??= (error as Error).message;
  }
  return { via: "none", problem, canLogIn: await canLogIn() };
}

/**
 * The site's actions, plugins' included (they're listed to signed-in users). Without the site, the
 * built-in ones, which are the same everywhere.
 */
export async function siteActions(site: Site | null, token: string | undefined): Promise<{ actions: ActionDescription[], fromSite: boolean }> {
  if(site) {
    const response = await fetch(`${site.url}${site.prefix}/api/actions`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if(response?.ok) {
      const { actions } = await response.json() as { actions: ActionDescription[] };
      return { actions, fromSite: true };
    }
  }
  return { actions: describeActions(listActions(coreActions)), fromSite: false };
}
