import type { AdminClient } from "../index.ts";
import { read, siteApi } from "./client.ts";

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
  reveals: number,
  /** Follows the editor: opening a document with a page on the site shows that page. Remembered per browser. */
  synced: boolean,
  /** The picker is on: clicking in the preview opens that block or field here instead. */
  picking: boolean,
  /** Outlines the blocks your unpublished changes touch. Remembered per browser. */
  highlight: boolean
}

/** The blocks to outline on one page of the site. */
export interface PreviewChanges {
  path: string,
  blocks: Array<{ index: number, kind: "added" | "changed" | "moved" }>
}

const SYNC_KEY = "vibe-cms:preview-sync";
const HIGHLIGHT_KEY = "vibe-cms:preview-highlight";

function loadHighlight(): boolean {
  try {
    return localStorage.getItem(HIGHLIGHT_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadSynced(): boolean {
  try {
    return localStorage.getItem(SYNC_KEY) === "1";
  } catch {
    return true;
  }
}

let state: PreviewState = { open: false, src: null, path: null, ready: false, reveals: 0, synced: typeof window !== "undefined" && loadSynced(), picking: false, highlight: typeof window === "undefined" || loadHighlight() };
/** What the document open in the editor changes on its page, for the preview to outline. */
let changes: PreviewChanges | null = null;
/** The site page of the document open in the editor, if it has one. */
let editorPage: string | null = null;
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

/** A URL that signs a new window into preview mode and lands on `path`; for a pop-out, in its window page. */
async function handoff(path: string, popOut = false): Promise<string> {
  const { code } = await read(await siteApi(prefix).preview.$post());
  return `${prefix}/preview?code=${encodeURIComponent(code)}&path=${encodeURIComponent(path)}${popOut ? "&window=1" : ""}`;
}

/** Points the open window at `path`: in place once it's signed in, else through a new handoff. */
async function navigate(path: string) {
  if(path === state.path) return;
  if(signedIn && frame) frame.postMessage({ type: "vibe:preview-navigate", path }, location.origin);
  else set({ ready: false, src: await handoff(path) });
}

/** Opens the floating preview, at `path` when given, else where it was (or the home page). */
export async function openPreview(path?: string) {
  const target = path ?? (state.synced ? editorPage : null) ?? state.path ?? "/";
  if(state.open) {
    if(path) await navigate(path);
    set({ reveals: state.reveals + 1 });
    return;
  }
  set({ open: true, ready: false, src: signedIn && frame ? target : await handoff(target), reveals: state.reveals + 1 });
}

/** The editor opened a document with a page on the site (or left it: null). A synced preview follows, without coming out of its corner. */
export function setEditorPage(path: string | null) {
  editorPage = path;
  if(path && state.synced && state.open) void navigate(path).catch(() => {});
}

export function setPreviewSynced(synced: boolean) {
  try {
    localStorage.setItem(SYNC_KEY, synced ? "1" : "0");
  } catch {}
  set({ synced });
  if(synced && editorPage && state.open) void navigate(editorPage).catch(() => {});
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
  set({ open: false, src: null, ready: false, picking: false });
  // Pop-outs keep theirs (Exit on their badge clears it); it lapses within the hour regardless.
  for(const target of windows) {
    if("closed" in target && target.closed) windows.delete(target);
  }
  if(windows.size === 0) void siteApi(prefix).preview.$delete().catch(() => {});
}

export function reloadPreview() {
  frame?.postMessage({ type: "vibe:preview-reload" }, location.origin);
}

/** Opens the current page in a window of its own, which keeps reloading on saves. */
export async function popOutPreview() {
  // Opened before the request, while the click still counts as a user gesture.
  const popup = window.open("", "vibe-cms-preview", "popup,width=1280,height=860");
  if(!popup) return false;
  popup.location.href = await handoff(state.path ?? "/", true);
  windows.add(popup);
  closePreview();
  return true;
}

/** Scrolls the preview to the `index`th block of the page's blocks, and outlines it. */
export function focusPreviewBlock(index: number) {
  frame?.postMessage({ type: "vibe:preview-focus", index }, location.origin);
  set({ reveals: state.reveals + 1 });
}

function sendChanges(target: MessageEventSource | null) {
  const message = { type: "vibe:preview-changes", changes: state.highlight ? changes : null };
  if(target && "postMessage" in target) (target as Window).postMessage(message, location.origin);
}

/** The blocks the open document's unpublished changes touch on its page; null when there's nothing to show. */
export function setPreviewChanges(next: PreviewChanges | null) {
  changes = next;
  sendChanges(frame);
  for(const target of windows) sendChanges(target);
}

export function setPreviewHighlight(highlight: boolean) {
  try {
    localStorage.setItem(HIGHLIGHT_KEY, highlight ? "1" : "0");
  } catch {}
  set({ highlight });
  setPreviewChanges(changes);
}

/** Turns the picker on or off; each page the window loads is told again (see the message listener). */
export function setPreviewPicking(picking: boolean) {
  set({ picking });
  frame?.postMessage({ type: "vibe:preview-pick-mode", on: picking }, location.origin);
}

let pickHandler: ((pick: unknown) => void) | null = null;

/** Who opens what the picker picks (the editor's layout, which can navigate). */
export function onPreviewPick(handler: ((pick: unknown) => void) | null) {
  pickHandler = handler;
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
    const message = event.data as { type?: string, path?: string, shift?: boolean, on?: boolean } | null;
    if(message?.type === "vibe:preview-ready") {
      if(event.source === frame) {
        signedIn = true;
        set({ path: typeof message.path === "string" ? message.path : null, ready: true });
        if(state.picking) frame?.postMessage({ type: "vibe:preview-pick-mode", on: true }, location.origin);
      } else {
        // A pop-out, maybe from before this editor reloaded.
        windows.add(event.source);
      }
      sendChanges(event.source);
    }
    if(message?.type === "vibe:preview-pick") pickHandler?.(message);
    // Escape pressed in the preview turns the picker off.
    if(message?.type === "vibe:preview-pick-mode" && event.source === frame) set({ picking: Boolean(message.on) });
    // ⌘S pressed inside a preview: replay it here, where the editor listens.
    if(message?.type === "vibe:preview-key") {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: Boolean(message.shift), cancelable: true }));
    }
  });
}
