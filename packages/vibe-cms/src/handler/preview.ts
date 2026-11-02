// @ts-ignore: sites needn't have node's types; Workers provide the module under `nodejs_compat`, which vibe-cms requires.
import { AsyncLocalStorage } from "node:async_hooks";
import type { Session } from "../server/index.ts";

/**
 * Draft preview: the editor opens the site with a `vibe_preview` cookie, and every request carrying a
 * valid one renders inside this scope, where `vibe.client(env)` reads drafts. One store per isolate,
 * on a global symbol, so `@vibe-cms/blocks` can check it without importing node APIs into browser bundles.
 */
export interface PreviewScope {
  session: Session
}

/** The part of node's `AsyncLocalStorage` this uses. */
interface Store<T> {
  getStore(): T | undefined,
  run<R>(store: T, fn: () => R): R
}

const KEY = Symbol.for("vibe-cms.preview");
const global = globalThis as { [KEY]?: Store<PreviewScope> };
export const previewScope: Store<PreviewScope> = global[KEY] ??= new (AsyncLocalStorage as new () => Store<PreviewScope>)();

export const PREVIEW_COOKIE = "vibe_preview";

/** Whether the current request is an editor's draft preview. Use it to skip caches of your own. */
export function isPreview(): boolean {
  return previewScope.getStore() !== undefined;
}

/** Only paths on this site: `/x`, never `//host` or a full URL. */
export function safePath(path: string | null): string {
  return path && /^\/(?![/\\])/.test(path) ? path : "/";
}

/**
 * The cookie for a preview session. Over HTTPS it's `SameSite=None; Partitioned`, so it works in the
 * editor's frame inside a panel on another site (partitioned to that panel); over plain HTTP (local
 * development, where panel and site are the same site) `Lax` is enough.
 */
export function previewCookie(value: string, maxAge: number, secure: boolean): string {
  const attributes = secure ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax";
  return `${PREVIEW_COOKIE}=${value}; Path=/; HttpOnly; Max-Age=${maxAge}; ${attributes}`;
}

/** Preview pages are never cached or indexed; HTML pages get the preview script. */
export async function decoratePreview(response: Response, prefix: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex");
  if(!headers.get("content-type")?.includes("text/html")) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  // Read here, inside the preview scope, so a streamed render still sees it.
  const html = await response.text();
  const tag = `<script src="${prefix}/preview.js" defer></script>`;
  const at = html.lastIndexOf("</body>");
  headers.delete("content-length");
  return new Response(at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at), { status: response.status, statusText: response.statusText, headers });
}

/** `GET {prefix}/preview.js`: the script preview pages load. */
export function previewScriptResponse(prefix: string): Response {
  return new Response(`(${PREVIEW_CLIENT})(${JSON.stringify(prefix)});`, {
    headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }
  });
}

/**
 * Runs in preview pages. Plain JavaScript in a string: bundlers (esbuild's `keepNames`) would add helpers to
 * a serialized function. Talks to the editor that opened it (its frame's parent, or a popup's opener):
 * announces each page, reloads when content is saved (keeping the scroll position), forwards ⌘S, and
 * outlines a block on request.
 */
const PREVIEW_CLIENT = String.raw`function(prefix) {
  var host = window.parent !== window ? window.parent : window.opener;
  var scrollKey = "vibe-cms:preview-scroll";
  var reloading = false;
  function here() { return location.pathname + location.search; }

  function post(message) {
    try { if(host) host.postMessage(message, location.origin); } catch (e) {}
  }

  function reload() {
    if(reloading) return;
    reloading = true;
    try { sessionStorage.setItem(scrollKey, JSON.stringify({ path: here(), y: scrollY })); } catch (e) {}
    location.reload();
  }

  function restoreScroll() {
    try {
      var saved = JSON.parse(sessionStorage.getItem(scrollKey) || "null");
      if(!saved || saved.path !== here()) return;
      scrollTo(0, saved.y);
      // Again once images have loaded, in case they moved things; then forget it.
      addEventListener("load", function() {
        scrollTo(0, saved.y);
        sessionStorage.removeItem(scrollKey);
      }, { once: true });
    } catch (e) {}
  }

  // The elements between <!--vibe-block:N--> and the next block marker.
  function blockElements(index) {
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    var start = null;
    while(walker.nextNode()) {
      if(walker.currentNode.nodeValue === "vibe-block:" + index) { start = walker.currentNode; break; }
    }
    var elements = [];
    for(var node = start && start.nextSibling; node; node = node.nextSibling) {
      if(node.nodeType === Node.COMMENT_NODE && /^\/?vibe-blocks?(:\d+)?$/.test(node.nodeValue || "")) break;
      if(node.nodeType === Node.ELEMENT_NODE) elements.push(node);
    }
    return elements;
  }

  function focusBlock(index) {
    var rects = blockElements(index).map(function(el) { return el.getBoundingClientRect(); }).filter(function(r) { return r.width || r.height; });
    if(!rects.length) return;
    var top = Math.min.apply(null, rects.map(function(r) { return r.top; })) + scrollY;
    var bottom = Math.max.apply(null, rects.map(function(r) { return r.bottom; })) + scrollY;
    var left = Math.min.apply(null, rects.map(function(r) { return r.left; })) + scrollX;
    var right = Math.max.apply(null, rects.map(function(r) { return r.right; })) + scrollX;
    var still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollTo({ top: Math.max(0, top - Math.max(24, (innerHeight - (bottom - top)) / 2)), behavior: still ? "auto" : "smooth" });
    var old = document.getElementById("vibe-preview-focus");
    if(old) old.remove();
    var ring = document.createElement("div");
    ring.id = "vibe-preview-focus";
    ring.style.cssText = "position:absolute;z-index:2147483647;pointer-events:none;top:" + top + "px;left:" + left + "px;width:" + (right - left) + "px;height:" + (bottom - top) + "px;"
      + "outline:2px solid #3b82f6;outline-offset:2px;border-radius:4px;background:rgb(59 130 246 / 0.08);transition:opacity .6s ease 1.2s;";
    document.body.append(ring);
    requestAnimationFrame(function() { requestAnimationFrame(function() { ring.style.opacity = "0"; }); });
    ring.addEventListener("transitionend", function() { ring.remove(); });
  }

  function onMessage(data) {
    if(!data) return;
    if(data.type === "vibe:preview-reload") reload();
    if(data.type === "vibe:preview-focus" && typeof data.index === "number") focusBlock(data.index);
    if(data.type === "vibe:preview-navigate" && typeof data.path === "string" && /^\/(?![\/\\])/.test(data.path)) location.assign(data.path);
  }

  addEventListener("message", function(event) {
    if(event.origin === location.origin) onMessage(event.data);
  });
  // Editors in other tabs of this browser (same storage partition) save too.
  try { new BroadcastChannel("vibe-cms:preview").onmessage = function(event) { onMessage(event.data); }; } catch (e) {}

  // Cmd/Ctrl+S (and with Shift) belong to the editor, even with focus in the preview.
  addEventListener("keydown", function(event) {
    if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s" && host) {
      event.preventDefault();
      post({ type: "vibe:preview-key", key: "s", shift: event.shiftKey });
    }
  });

  restoreScroll();
  post({ type: "vibe:preview-ready", path: here(), title: document.title });

  // Opened directly or popped out: say it's a preview, with a way out.
  if(window.parent === window) {
    var badge = document.createElement("div");
    badge.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147483647;display:flex;gap:10px;align-items:center;padding:6px 10px;"
      + "border-radius:999px;background:#18181b;color:#fafafa;font:500 12px/1.2 system-ui,sans-serif;box-shadow:0 4px 16px rgb(0 0 0 / .25);";
    var label = document.createElement("span");
    label.textContent = "Draft preview";
    var exit = document.createElement("a");
    exit.textContent = "Exit";
    exit.href = prefix + "/preview/exit?path=" + encodeURIComponent(here());
    exit.style.cssText = "color:#a1a1aa;text-decoration:underline;";
    badge.append(label, exit);
    document.body.append(badge);
  }
}`;
