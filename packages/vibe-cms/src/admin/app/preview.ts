import type { AdminClient } from "../index.ts";
import { request } from "./client.ts";

/**
 * The draft preview's state, outside React so the action client can announce saves. Preview pages
 * load `{prefix}/preview.js`, which reports each page here and reloads when told to.
 */
export interface PreviewState {
  open: boolean,
  /** What the floating window shows: a path on the site, or a `{prefix}/preview?code=…` handoff. */
  src: string | null,
  /** The page the window is on, as last reported by the preview script. */
  path: string | null,
  /** The window's page announced itself since it was last pointed somewhere. */
  ready: boolean,
  /** Bumped whenever the editor wants the window seen (opened, pointed at a page or a block), so a tucked one comes out. */
  reveals: number
}

let state: PreviewState = { open: false, src: null, path: null, ready: false, reveals: 0 };
const listeners = new Set<() => void>();
/** Pop-outs, and the floating window's frame, so saves reach them across storage partitions too. */
const windows = new Set<MessageEventSource>();
let frame: Window | null = null;
/** The frame has loaded a preview page, so its cookie works and paths can be opened directly. */
let signedIn = false;
let prefix = "/_vibe";

function set(next: Partial<PreviewState>) {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

export function getPreview(): PreviewState {
  return state;
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPreviewPrefix(next: string) {
  prefix = next;
}

export function setPreviewFrame(next: Window | null) {
  frame = next;
}

/** A URL that signs a new window into preview mode and lands on `path`. */
async function handoff(path: string): Promise<string> {
  const { code } = await request<{ code: string }>(prefix, "/preview", { method: "POST" });
  return `${prefix}/preview?code=${encodeURIComponent(code)}&path=${encodeURIComponent(path)}`;
}

/** Opens the floating preview, at `path` when given, else where it was (or the home page). */
export async function openPreview(path?: string) {
  const target = path ?? state.path ?? "/";
  if(state.open && signedIn && frame) {
    if(path && path !== state.path) frame.postMessage({ type: "vibe:preview-navigate", path }, location.origin);
    set({ reveals: state.reveals + 1 });
    return;
  }
  set({ open: true, ready: false, src: signedIn ? target : await handoff(target), reveals: state.reveals + 1 });
}

/** `openPreview`, telling the user when it can't. */
export async function showPreview(cms: AdminClient, path?: string) {
  try {
    await openPreview(path);
  } catch (error) {
    cms.toast(`Couldn't open the preview: ${(error as Error).message}`, { type: "error" });
  }
}

export function closePreview() {
  // The next window signs in again, in case this cookie expired meanwhile.
  signedIn = false;
  set({ open: false, src: null, ready: false });
}

export function reloadPreview() {
  frame?.postMessage({ type: "vibe:preview-reload" }, location.origin);
}

/** Opens the current page in a window of its own, which keeps reloading on saves. */
export async function popOutPreview() {
  // Opened before the request, while the click still counts as a user gesture.
  const popup = window.open("", "vibe-cms-preview", "popup,width=1280,height=860");
  if(!popup) return false;
  popup.location.href = await handoff(state.path ?? "/");
  windows.add(popup);
  closePreview();
  return true;
}

/** Scrolls the preview to the `index`th block of the page's blocks, and outlines it. */
export function focusPreviewBlock(index: number) {
  frame?.postMessage({ type: "vibe:preview-focus", index }, location.origin);
  set({ reveals: state.reveals + 1 });
}

let pending: ReturnType<typeof setTimeout> | undefined;
const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("vibe-cms:preview");

/** Content changed: every open preview reloads, once, after a burst of writes. */
export function notifyPreview() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    const message = { type: "vibe:preview-reload" };
    channel?.postMessage(message);
    for(const target of windows) {
      if("closed" in target && target.closed) windows.delete(target);
      else target.postMessage(message, { targetOrigin: location.origin });
    }
  }, 150);
}

if(typeof window !== "undefined") {
  window.addEventListener("message", event => {
    if(event.origin !== location.origin || !event.source) return;
    const message = event.data as { type?: string, path?: string, shift?: boolean } | null;
    if(message?.type === "vibe:preview-ready") {
      if(event.source === frame) {
        signedIn = true;
        set({ path: typeof message.path === "string" ? message.path : null, ready: true });
      } else {
        // A pop-out, maybe from before this editor reloaded.
        windows.add(event.source);
      }
    }
    // ⌘S pressed inside a preview: replay it here, where the editor listens.
    if(message?.type === "vibe:preview-key") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: Boolean(message.shift), cancelable: true }));
    }
  });
}
