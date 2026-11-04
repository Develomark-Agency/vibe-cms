import type { SiteSettings } from "../../handler/engine.ts";
import { read, setToken, siteApi, type SessionState, type SiteInfo } from "./client.ts";
import { getTheme, isTheme, setTheme, subscribeTheme, type Theme } from "./theme.ts";

/**
 * The panel ↔ editor message protocol (v1). The editor runs on the site's own
 * origin; the panel frames it and hands over one-time codes.
 */
export type PanelMessage =
  | { type: "vibe:code", code: string }
  | { type: "vibe:navigate", path: string }
  /** The panel's theme, and its accent for sites that don't set their own. */
  | { type: "vibe:appearance", theme: Theme, accent: string | null };

export type EditorMessage =
  | { type: "vibe:ready", protocol: 1 }
  | { type: "vibe:needCode" }
  | { type: "vibe:navigated", path: string }
  | { type: "vibe:title", title: string }
  | { type: "vibe:shortcut", key: string }
  /** The user changed the theme in the editor; the panel follows. */
  | { type: "vibe:theme", theme: Theme }
  /** The site's name, accent or icon changed. */
  | { type: "vibe:site", site: SiteSettings };

export const embedded = typeof window !== "undefined" && window.parent !== window;

/** Learned from the first code: everything beyond `ready`/`needCode` only goes to the panel that framed us. */
let panelOrigin: string | null = null;
const codeWaiters: Array<(code: string) => void> = [];
const navigateListeners = new Set<(path: string) => void>();
const accentListeners = new Set<() => void>();
let panelAccent: string | null = null;

if(embedded) {
  window.addEventListener("message", event => {
    if(event.source !== window.parent) return;
    const message = event.data as PanelMessage;
    if(message?.type === "vibe:code" && typeof message.code === "string") {
      panelOrigin = event.origin;
      codeWaiters.splice(0).forEach(resolve => resolve(message.code));
    }
    if(message?.type === "vibe:navigate" && typeof message.path === "string" && (event.origin === panelOrigin || panelOrigin === "*")) {
      navigateListeners.forEach(listener => listener(message.path));
    }
    // Only cosmetic, so accepted from the framing window before we know its origin.
    if(message?.type === "vibe:appearance") {
      if(isTheme(message.theme)) setTheme(message.theme);
      const accent = typeof message.accent === "string" && /^#[0-9a-f]{6}$/i.test(message.accent) ? message.accent : null;
      if(accent !== panelAccent) {
        panelAccent = accent;
        accentListeners.forEach(listener => listener());
      }
    }
  });
  // Echoes of the panel's own change are ignored there, since the theme is already set.
  subscribeTheme(() => postToPanel({ type: "vibe:theme", theme: getTheme() }));
}

/** The framing panel's accent, the fallback for sites without one. */
export function getPanelAccent(): string | null {
  return panelAccent;
}

export function subscribePanelAccent(listener: () => void): () => void {
  accentListeners.add(listener);
  return () => accentListeners.delete(listener);
}

export function postToPanel(message: EditorMessage) {
  if(!embedded) return;
  const open = message.type === "vibe:ready" || message.type === "vibe:needCode";
  if(!open && !panelOrigin) return;
  window.parent.postMessage(message, open ? "*" : panelOrigin!);
}

export function onPanelNavigate(listener: (path: string) => void) {
  navigateListeners.add(listener);
  return () => navigateListeners.delete(listener);
}

function requestCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The panel didn't send a sign-in code")), 15_000);
    codeWaiters.push(code => {
      clearTimeout(timer);
      resolve(code);
    });
    postToPanel({ type: "vibe:needCode" });
  });
}

interface SessionResponse extends Omit<SessionState, "token"> {
  token?: string
}

async function exchange(prefix: string, input: { code?: string, dev?: boolean, resume?: boolean }): Promise<SessionState> {
  const session: SessionResponse = await read(await siteApi(prefix).session.$post({ json: input }));
  setToken(session.token);
  return session;
}

/**
 * Works out how this editor was opened and establishes a session. Editors of sites in an org run
 * framed by the hub, which hands over codes; on their own they show the way to the hub. Sites that
 * sign people in themselves trade the browser's sign-in cookie for a session. Development editors
 * sign in as the developer, framed or not.
 */
export async function startSession(info: SiteInfo): Promise<SessionState | null> {
  const { prefix } = info;
  if(embedded) {
    postToPanel({ type: "vibe:ready", protocol: 1 });
    // Local development needs no identity provider, so no code ever tells us who the panel is.
    if(info.dev) {
      panelOrigin = "*";
      return exchange(prefix, { dev: true });
    }
    return exchange(prefix, { code: await requestCode() });
  }
  if(info.dev) return exchange(prefix, { dev: true });
  if(info.signIn !== "hub") {
    try {
      return await exchange(prefix, { resume: true });
    } catch (error) {
      if((error as { status?: number }).status === 401) return null;
      throw error;
    }
  }
  return null;
}

/** After expiry: the same again, so a framed editor asks the hub for a fresh code without a word to the user. */
export function renewSession(info: SiteInfo): Promise<SessionState | null> {
  return startSession(info);
}

export async function signOut(prefix: string) {
  setToken(undefined);
  await siteApi(prefix).session.$delete().catch(() => {});
}
