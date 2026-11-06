// @ts-ignore: sites needn't have node's types; Workers provide the module under `nodejs_compat`, which vibe-cms requires.
import { AsyncLocalStorage } from "node:async_hooks";
import type { AnySchema } from "../schema/types.ts";
import type { Session } from "../server/index.ts";

/**
 * Draft preview: the editor opens the site with a `vibe_preview` cookie, and every request carrying a
 * valid one renders inside this scope, where `vibe.client(env)` reads drafts. One store per isolate,
 * on a global symbol, so `vibe-cms/blocks` and `field()` can check it without importing node APIs into browser bundles.
 */
export interface PreviewScope {
  session: Session,
  /** Where each array and object in this render's query results came from, for `field()` and `<Blocks>`. */
  sources: WeakMap<object, PickSource>,
  /**
   * The preview script's background render for the editor's picker (the `x-vibe-pick` header), never
   * the page on screen: `<Blocks>` adds each block's variants.
   */
  pick?: boolean
}

/** Where a value in a query result lives: its document, and its path in the document's fields. */
export interface PickSource {
  type: string,
  id: string,
  locale: string,
  path: Array<string | number>
}

export const PICK_HEADER = "x-vibe-pick";

type Schema = AnySchema & { inner?: AnySchema, item?: AnySchema, shape?: Record<string, AnySchema>, options?: readonly AnySchema[], to?: string };

/** The collection an expanded reference at `path` in a `type` document points to: a ref field's `to`, or a reverse `with` (`posts`). */
function referenced(schemas: Record<string, AnySchema>, type: string, path: Array<string | number>): string | null {
  let schema = schemas[type] as Schema | undefined;
  for(const key of path) {
    while(schema?.type === "optional") schema = schema.inner as Schema;
    if(!schema) return null;
    if(typeof key === "number") schema = schema.type === "array" ? schema.item as Schema : undefined;
    else if(schema.type === "union") schema = schema.options!.map(option => (option as Schema).shape?.[key]).find(Boolean) as Schema | undefined;
    else if(schema.type === "object") {
      const field = schema.shape![key] as Schema | undefined;
      if(!field && key.endsWith("s") && schemas[key.slice(0, -1)] && key === path.at(-1)) return key.slice(0, -1);
      schema = field;
    } else return null;
  }
  while(schema?.type === "optional") schema = schema.inner as Schema;
  return schema?.type === "ref" && schema.to ? schema.to : null;
}

/**
 * Remembers where each array and object in query results came from. Expanded references count as their
 * own documents, when the schema says which collection they're from.
 */
export function recordSources(schemas: Record<string, AnySchema>, sources: WeakMap<object, PickSource>, types: string[], results: unknown[]) {
  type Doc = { id?: unknown, $meta?: { locale?: string } };
  function document(doc: Doc, type: string) {
    walk(doc, { type, id: doc.id as string, locale: doc.$meta?.locale ?? "" }, []);
  }
  function walk(value: unknown, source: Omit<PickSource, "path">, path: Array<string | number>) {
    if(typeof value !== "object" || value === null) return;
    if(path.length > 0 && !Array.isArray(value) && "$meta" in value) {
      const doc = value as Doc;
      // The last key naming the collection, for the list of a reverse `with` (`posts`, then an index).
      const at = typeof path.at(-1) === "number" ? path.slice(0, -1) : path;
      const type = referenced(schemas, source.type, at);
      if(type && typeof doc.id === "string") document(doc, type);
      return;
    }
    sources.set(value, { ...source, path });
    if(Array.isArray(value)) value.forEach((item, i) => walk(item, source, [...path, i]));
    else for(const [key, item] of Object.entries(value)) if(key !== "$meta") walk(item, source, [...path, key]);
  }
  results.forEach((result, i) => {
    for(const doc of (Array.isArray(result) ? result : [result]) as Array<Doc | null>) {
      if(typeof doc === "object" && doc !== null && typeof doc.id === "string") document(doc, types[i]!);
    }
  });
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
/** Seconds a preview cookie lasts; each preview page renews it, so it only outlives an open preview by this much. */
export const PREVIEW_TTL = 60 * 60;

/**
 * Whether a request carrying the cookie should render drafts. Only pages loaded in a frame do: the
 * editor's floating window, and the pop-out's window page. A page opened in a tab of its own
 * (`Sec-Fetch-Dest: document`) is the live site, whatever cookie the browser holds. Browsers that
 * don't send the header (older than Safari 16.4) get the preview wherever the cookie goes.
 */
export function wantsPreview(request: Request): boolean {
  return request.headers.get("sec-fetch-dest") !== "document";
}

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

/** Preview pages are never cached or indexed; HTML pages get the preview script and renew the cookie. */
export async function decoratePreview(response: Response, prefix: string, renew: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-robots-tag", "noindex");
  if(!headers.get("content-type")?.includes("text/html")) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  headers.append("set-cookie", renew);
  // Read here, inside the preview scope, so a streamed render still sees it.
  const html = await response.text();
  const tag = `<script src="${prefix}/preview.js" defer></script>`;
  const at = html.lastIndexOf("</body>");
  headers.delete("content-length");
  return new Response(at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at), { status: response.status, statusText: response.statusText, headers });
}

/**
 * `GET {prefix}/preview/window?path=/…`: the pop-out. The site loads in a frame filling the window,
 * so it's a framed page like the floating one (see `wantsPreview`); this page passes messages
 * between the frame and the editor that opened it, and says it's a preview, with a way out.
 */
export function previewWindowResponse(prefix: string, path: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Draft preview</title>
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  iframe { display: block; width: 100%; height: 100%; border: 0; }
  #badge { position: fixed; left: 12px; bottom: 12px; display: flex; gap: 10px; align-items: center; padding: 6px 10px; border-radius: 999px;
    background: #18181b; color: #fafafa; font: 500 12px/1.2 system-ui, sans-serif; box-shadow: 0 4px 16px rgb(0 0 0 / .25); }
  #badge a { color: #a1a1aa; }
</style>
</head>
<body>
<iframe id="frame" title="Draft preview" src="${escapeAttribute(path)}"></iframe>
<div id="badge"><span>Draft preview</span><a id="exit" target="_top">Exit</a></div>
<script>${String.raw`(function(prefix) {
  var frame = document.getElementById("frame");
  var exit = document.getElementById("exit");
  function show(path) {
    exit.href = prefix + "/preview/exit?path=" + encodeURIComponent(path);
  }
  show(frame.getAttribute("src"));
  addEventListener("message", function(event) {
    if(event.origin !== location.origin) return;
    if(event.source === frame.contentWindow) {
      // The page reports where it is and passes keys on; the editor gets them as if from this window.
      if(event.data && event.data.type === "vibe:preview-ready") {
        show(event.data.path);
        if(event.data.title) document.title = event.data.title + " · Draft preview";
      }
      if(window.opener) window.opener.postMessage(event.data, location.origin);
    } else if(event.source === window.opener) {
      frame.contentWindow.postMessage(event.data, location.origin);
    }
  });
})`}(${JSON.stringify(prefix)});</script>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
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

  // --- The picker ---------------------------------------------------------------------------------
  // While the editor's picker is on, hovering outlines the block or field under the pointer and a click
  // opens it in the editor. Nothing here touches the page until then. Which element shows which field
  // comes from a second render of this page (the x-vibe-pick header), where <Blocks> renders each block
  // again with each field changed; comparing them says what each field changes, however a component
  // transforms it. That render is only read, never shown.
  var picking = false;
  var pickData = null;
  var markers = null;
  var hovered = null;
  var overlay = null;
  var pickStyle = null;
  var markerRe = /^vibe-block:(\d+)$/;
  var endRe = /^\/?vibe-blocks?(:\d+)?$/;

  function humanize(key) {
    var words = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  // Which <Blocks> on the page (in order) and which block in it: the same in this page and the picker's render.
  function locate(root) {
    var walker = root.createTreeWalker(root.body || root, NodeFilter.SHOW_COMMENT | NodeFilter.SHOW_ELEMENT);
    var found = [];
    var list = 0;
    while(walker.nextNode()) {
      var node = walker.currentNode;
      if(node.nodeType === Node.COMMENT_NODE) {
        if(node.nodeValue === "/vibe-blocks") list++;
        else if(markerRe.test(node.nodeValue || "")) found.push({ node: node, list: list, index: Number(markerRe.exec(node.nodeValue)[1]) });
      } else if(node.tagName === "TEMPLATE" && node.hasAttribute("data-vibe-variants")) {
        found.push({ node: node, list: list, index: Number(node.getAttribute("data-vibe-variants")) });
      }
    }
    return found;
  }

  // A block's top-level elements: those after its marker, up to the next marker.
  function rootsAfter(marker) {
    var roots = [];
    for(var node = marker.nextSibling; node; node = node.nextSibling) {
      if(node.nodeType === Node.COMMENT_NODE && endRe.test(node.nodeValue || "")) break;
      if(node.nodeType === Node.ELEMENT_NODE) roots.push(node);
    }
    return roots;
  }

  // The block an element is in: its marker and the element's path in it (indexes of element children).
  function blockOf(element) {
    var path = [];
    for(var node = element; node && node !== document.body && node !== document.documentElement; node = node.parentNode) {
      for(var before = node.previousSibling; before; before = before.previousSibling) {
        if(before.nodeType !== Node.COMMENT_NODE) continue;
        if(markerRe.test(before.nodeValue || "")) {
          var roots = rootsAfter(before);
          path.unshift(roots.indexOf(node));
          return { marker: before, roots: roots, path: path };
        }
        if(endRe.test(before.nodeValue || "")) break;
      }
      if(node.parentNode && node.parentNode.children) path.unshift(Array.prototype.indexOf.call(node.parentNode.children, node));
    }
    return null;
  }

  function significant(node) {
    return Array.prototype.filter.call(node.childNodes, function(child) {
      return child.nodeType === Node.ELEMENT_NODE || child.nodeType === Node.TEXT_NODE;
    });
  }

  function sameAttributes(a, b) {
    // Islands carry their props and a fresh id in attributes; what they render is compared instead.
    if(/^ASTRO-/.test(a.tagName)) return true;
    // Variants are copies, which field() can't mark: its marks aren't differences.
    var ignore = (a.hasAttribute("data-vibe-field") ? 1 : 0) - (b.hasAttribute("data-vibe-field") ? 1 : 0);
    if(a.attributes.length - b.attributes.length !== ignore) return false;
    for(var i = 0; i < a.attributes.length; i++) {
      if(a.attributes[i].name === "data-vibe-field") continue;
      if(b.getAttribute(a.attributes[i].name) !== a.attributes[i].value) return false;
    }
    return true;
  }

  // Paths ("0.2.1") of the elements whose own attributes or text differ between two renders.
  function differences(a, b, path, out) {
    if(a.nodeType === Node.ELEMENT_NODE) {
      if(a.tagName !== b.tagName) { out.push(path); return out; }
      if(!sameAttributes(a, b)) out.push(path);
    }
    var ka = significant(a), kb = significant(b);
    var own = ka.length !== kb.length;
    for(var i = 0; !own && i < ka.length; i++) {
      if(ka[i].nodeType !== kb[i].nodeType) own = true;
      else if(ka[i].nodeType === Node.TEXT_NODE ? ka[i].data !== kb[i].data : ka[i].tagName !== kb[i].tagName) own = true;
    }
    if(own) {
      if(out[out.length - 1] !== path) out.push(path);
      return out;
    }
    var ca = a.children, cb = b.children;
    for(var j = 0; j < ca.length; j++) differences(ca[j], cb[j], path === "" ? String(j) : path + "." + j, out);
    return out;
  }

  // For one block: which fields change which element (by path), from its variants.
  function fieldMap(entry) {
    if(entry.map) return entry.map;
    var map = {};
    var noisy = {};
    if(entry.base && entry.noise) differences(entry.base, entry.noise, "", []).forEach(function(path) { noisy[path] = true; });
    if(entry.base) {
      entry.variants.forEach(function(variant) {
        var paths = differences(entry.base, variant.content, "", []).filter(function(path) { return !noisy[path]; });
        paths.forEach(function(path) {
          (map[path] = map[path] || []).push({ field: variant.field, spread: paths.length });
        });
      });
    }
    entry.map = map;
    return map;
  }

  function loadPickData() {
    if(pickData) return;
    pickData = { blocks: {} };
    var data = pickData;
    fetch(location.href, { headers: { "x-vibe-pick": "1" }, credentials: "same-origin", cache: "no-store" })
      .then(function(response) { return response.text(); })
      .then(function(markup) {
        var parsed = new DOMParser().parseFromString(markup, "text/html");
        locate(parsed).forEach(function(found) {
          if(found.node.nodeType !== Node.ELEMENT_NODE) return;
          var entry = { source: null, type: found.node.getAttribute("data-vibe-type"), base: null, noise: null, variants: [], map: null };
          try { entry.source = JSON.parse(found.node.getAttribute("data-vibe-source") || "null"); } catch (e) {}
          Array.prototype.forEach.call(found.node.content.children, function(variant) {
            var path = variant.getAttribute("data-vibe-path");
            if(path === "@base") entry.base = variant.content;
            else if(path === "@noise") entry.noise = variant.content;
            else { try { entry.variants.push({ field: JSON.parse(path), content: variant.content }); } catch (e) {} }
          });
          data.blocks[found.list + ":" + found.index] = entry;
        });
      })
      .catch(function() {});
  }

  function elementAt(fragment, path) {
    var node = fragment;
    for(var i = 0; i < path.length && node; i++) node = node.children[path[i]];
    return node;
  }

  // What's under the pointer: the block, and the field whose element most closely contains it.
  // An element the site marked with field() (data-vibe-field): exactly which document and field it shows.
  function marked(element) {
    var el = element.closest("[data-vibe-field]");
    if(!el) return null;
    try {
      var mark = JSON.parse(el.getAttribute("data-vibe-field"));
      return mark && typeof mark.type === "string" && Array.isArray(mark.path) ? { element: el, mark: mark } : null;
    } catch (e) { return null; }
  }

  // What's under the pointer: a field() mark, or what the block's variants say, whichever is closer to it.
  function target(element) {
    var found = blockTarget(element);
    var explicit = marked(element);
    var inner = found && (found.element || found.roots[0]);
    if(!explicit || (inner && inner !== explicit.element && explicit.element.contains(inner))) return found;
    var result = { list: found ? found.list : 0, index: null, roots: [explicit.element], element: explicit.element, field: explicit.mark.path, entry: null, mark: explicit.mark };
    // Inside a block from the same document: named after the block, like the block's own fields.
    var source = found && found.entry && found.entry.source;
    if(source && source.type === explicit.mark.type && source.id === explicit.mark.id && explicit.mark.path.length > source.path.length
      && source.path.concat([found.index]).every(function(key, i) { return String(key) === String(explicit.mark.path[i]); })) {
      result.entry = found.entry;
      result.index = found.index;
      result.field = explicit.mark.path.slice(source.path.length + 1);
      result.mark = null;
    }
    return result;
  }

  function blockTarget(element) {
    var block = blockOf(element);
    if(!block || block.path[0] < 0) return null;
    // Markers are looked up once per page (and again if the page changed since).
    var mark = (markers || []).filter(function(found) { return found.node === block.marker; })[0];
    if(!mark) {
      markers = locate(document);
      mark = markers.filter(function(found) { return found.node === block.marker; })[0];
    }
    var list = mark ? mark.list : 0;
    var index = Number(markerRe.exec(block.marker.nodeValue)[1]);
    var entry = pickData && pickData.blocks[list + ":" + index];
    var result = { list: list, index: index, roots: block.roots, element: null, field: [], entry: entry };
    if(!entry) return result;
    var map = fieldMap(entry);
    for(var depth = block.path.length; depth >= 0; depth--) {
      var path = block.path.slice(0, depth);
      var found = map[path.join(".")];
      if(!found) continue;
      var live = depth === 0 ? null : elementAt({ children: block.roots }, path);
      var rendered = depth === 0 ? null : elementAt(entry.base, path);
      if(depth > 0 && (!live || !rendered || live.tagName !== rendered.tagName)) continue;
      // Of the fields changing this element, the one that changes the least elsewhere.
      var best = found.slice().sort(function(a, b) { return a.spread - b.spread; })[0];
      result.element = live;
      result.field = best.field;
      return result;
    }
    return result;
  }

  function label(found) {
    var type = found.mark ? humanize(found.mark.type) : found.entry && found.entry.type ? humanize(found.entry.type) : "Block " + (found.index + 1);
    // The field, and the one in it for short paths (Plans › Monthly); deeper ones are inside a field's own value, like rich text.
    var keys = found.field.filter(function(key) { return typeof key === "string"; }).map(humanize);
    if(found.field.length > 3) keys = keys.slice(0, 1);
    else if(keys.length > 2) keys = [keys[0], keys[keys.length - 1]];
    return [type].concat(keys).join(" › ");
  }

  function drawHover() {
    if(!overlay) {
      overlay = document.createElement("div");
      overlay.id = "vibe-preview-pick";
      overlay.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;outline:2px solid #3b82f6;outline-offset:1px;border-radius:3px;"
        + "background:rgb(59 130 246 / 0.08);display:none;";
      var tag = document.createElement("span");
      tag.style.cssText = "position:absolute;left:-3px;bottom:100%;margin-bottom:4px;padding:2px 6px;border-radius:4px;background:#3b82f6;color:#fff;"
        + "font:500 11px/1.4 system-ui,sans-serif;white-space:nowrap;";
      overlay.append(tag);
      document.body.append(overlay);
    }
    if(!hovered) { overlay.style.display = "none"; return; }
    var rects = (hovered.element ? [hovered.element] : hovered.roots).map(function(el) { return el.getBoundingClientRect(); }).filter(function(r) { return r.width || r.height; });
    if(!rects.length) { overlay.style.display = "none"; return; }
    var top = Math.min.apply(null, rects.map(function(r) { return r.top; }));
    var left = Math.min.apply(null, rects.map(function(r) { return r.left; }));
    var bottom = Math.max.apply(null, rects.map(function(r) { return r.bottom; }));
    var right = Math.max.apply(null, rects.map(function(r) { return r.right; }));
    overlay.style.display = "block";
    overlay.style.top = top + "px";
    overlay.style.left = left + "px";
    overlay.style.width = (right - left) + "px";
    overlay.style.height = (bottom - top) + "px";
    var tag = overlay.firstChild;
    tag.textContent = label(hovered);
    // Inside the element when there's no room above it.
    tag.style.bottom = top < 24 ? "auto" : "100%";
    tag.style.top = top < 24 ? "4px" : "auto";
    tag.style.left = top < 24 ? "4px" : "-3px";
  }

  var frameRequested = false;
  var pointer = null;
  function update() {
    if(frameRequested) return;
    frameRequested = true;
    requestAnimationFrame(function() {
      frameRequested = false;
      // What's under the pointer now: scrolling moves the page under a still pointer.
      var element = pointer && document.elementFromPoint(pointer.x, pointer.y);
      hovered = element && element !== overlay ? target(element) : null;
      drawHover();
    });
  }

  function onPointerMove(event) {
    pointer = { x: event.clientX, y: event.clientY };
    update();
  }

  // Leaving the page (for the editor around it) clears the outline.
  function onPointerOut(event) {
    if(event.relatedTarget) return;
    pointer = null;
    update();
  }

  function swallow(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onPickClick(event) {
    swallow(event);
    var found = event.target.nodeType === Node.ELEMENT_NODE ? target(event.target) : null;
    if(!found) return;
    // A mark names its whole path; a block's field is under its list's source (or the open document's blocks).
    if(found.mark) post({ type: "vibe:preview-pick", source: { type: found.mark.type, id: found.mark.id, locale: found.mark.locale, path: found.mark.path }, index: null, field: [] });
    else post({ type: "vibe:preview-pick", source: found.entry ? found.entry.source : null, list: found.list, index: found.index, field: found.field });
  }

  function onPickKey(event) {
    if(event.key !== "Escape") return;
    swallow(event);
    setPicking(false);
    post({ type: "vibe:preview-pick-mode", on: false });
  }

  function onPickScroll() {
    update();
  }

  var swallowed = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "auxclick", "contextmenu", "submit", "dragstart"];

  function setPicking(on) {
    if(on === picking) return;
    picking = on;
    var method = on ? "addEventListener" : "removeEventListener";
    window[method]("pointermove", onPointerMove, true);
    window[method]("pointerout", onPointerOut, true);
    window[method]("click", onPickClick, true);
    window[method]("keydown", onPickKey, true);
    window[method]("scroll", onPickScroll, true);
    swallowed.forEach(function(type) { window[method](type, swallow, true); });
    if(on) {
      loadPickData();
      pickStyle = document.createElement("style");
      pickStyle.textContent = "*, *::before, *::after { cursor: crosshair !important; user-select: none !important; }";
      document.head.append(pickStyle);
    } else {
      if(pickStyle) pickStyle.remove();
      if(overlay) overlay.remove();
      pickStyle = overlay = hovered = pointer = null;
    }
  }

  function onMessage(data) {
    if(!data) return;
    if(data.type === "vibe:preview-pick-mode") setPicking(Boolean(data.on));
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

  // Only top-level in browsers that don't say where a page loads (see wantsPreview): say it's a preview, with a way out.
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
