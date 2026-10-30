import { request, setToken, type SessionState, type SiteInfo } from "./client.ts";

/**
 * The panel ↔ editor message protocol (v1). The editor runs on the site's own
 * origin; the panel frames it and hands over one-time codes.
 */
export type PanelMessage =
  | { type: "vibe:code", code: string }
  | { type: "vibe:navigate", path: string };

export type EditorMessage =
  | { type: "vibe:ready", protocol: 1 }
  | { type: "vibe:needCode" }
  | { type: "vibe:navigated", path: string }
  | { type: "vibe:title", title: string }
  | { type: "vibe:shortcut", key: string };

export const embedded = typeof window !== "undefined" && window.parent !== window;

/** Learned from the first code: everything beyond `ready`/`needCode` only goes to the panel that framed us. */
let panelOrigin: string | null = null;
const codeWaiters: Array<(code: string) => void> = [];
const navigateListeners = new Set<(path: string) => void>();

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
  });
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

async function exchange(prefix: string, input: { code?: string, dev?: boolean }, cookie: boolean): Promise<SessionState> {
  const session = await request<SessionResponse>(prefix, "/session", { method: "POST", json: { ...input, cookie } });
  setToken(session.token);
  return session;
}

/** Works out how this editor was opened and establishes a session. */
export async function startSession(info: SiteInfo): Promise<SessionState | null> {
  const { prefix } = info;
  if(embedded) {
    postToPanel({ type: "vibe:ready", protocol: 1 });
    // Local development needs no identity provider, so no code ever tells us who the panel is.
    if(info.dev) {
      panelOrigin = "*";
      return exchange(prefix, { dev: true }, false);
    }
    return exchange(prefix, { code: await requestCode() }, false);
  }
  const hash = new URLSearchParams(location.hash.slice(1));
  const code = hash.get("code");
  if(code) {
    // The fragment never reached a server; strip it before anything else can read it.
    history.replaceState(history.state, "", location.pathname + location.search);
    return exchange(prefix, { code }, true);
  }
  try {
    const existing = await request<SessionResponse | { user: null }>(prefix, "/session");
    if(existing.user) return existing as SessionResponse;
  } catch {
    // No cookie session.
  }
  if(info.dev) return exchange(prefix, { dev: true }, true);
  return null;
}

/** After expiry: embedded editors ask the panel again; full-page ones have to sign in again. */
export async function renewSession(info: SiteInfo): Promise<SessionState | null> {
  if(embedded) return startSession(info);
  if(info.dev) return exchange(info.prefix, { dev: true }, true);
  return null;
}

export async function signOut(prefix: string) {
  setToken(undefined);
  await request(prefix, "/session", { method: "DELETE" }).catch(() => {});
}
