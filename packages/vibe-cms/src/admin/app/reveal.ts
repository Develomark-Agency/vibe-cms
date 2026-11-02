import type { AnyConfig } from "../../config.ts";
import type { ArraySchema, OptionalSchema } from "../../schema/types.ts";
import type { Path } from "../../schema/validate.ts";
import { collectionSchema } from "./context.tsx";
import { match, navigate } from "./router.tsx";

/**
 * A field the editor was asked to show, by the preview's picker. Collapsed cards on its way open
 * (ArrayControl watches this), then it scrolls into view, takes focus and flashes.
 */
export interface Reveal {
  path: Path
}

let current: Reveal | null = null;
const listeners = new Set<() => void>();

export function getReveal(): Reveal | null {
  return current;
}

export function subscribeReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function revealField(path: Path) {
  const request = { path };
  current = request;
  listeners.forEach(listener => listener());
  scrollWhenRendered(request);
}

function fieldElement(path: Path): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-field="${CSS.escape(path.join("."))}"]`);
}

/**
 * Waits for the field to render (a document loading, cards opening), then shows it. Fields can be
 * deeper than the form goes (a rich text's paragraph), so after a moment the deepest one there will do.
 */
function scrollWhenRendered(request: Reveal) {
  const started = Date.now();
  let seen = 0;
  function attempt() {
    if(current !== request) return;
    let depth = request.path.length;
    let element: HTMLElement | null = null;
    for(; depth > 0 && !element; depth--) element = fieldElement(request.path.slice(0, depth));
    if(element && !seen) seen = Date.now();
    const complete = element !== null && depth + 1 === request.path.length;
    if(complete || (element && Date.now() - seen > 500) || Date.now() - started > 5000) {
      if(element) show(element);
      return;
    }
    requestAnimationFrame(attempt);
  }
  requestAnimationFrame(attempt);
}

function show(element: HTMLElement) {
  element.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  const control = element.querySelector<HTMLElement>("input:not([type=hidden]), textarea, [contenteditable=true], button[role=combobox], button[role=switch]");
  control?.focus({ preventScroll: true });
  element.removeAttribute("data-revealed");
  // Restarts the flash when the same field is picked twice.
  void element.offsetWidth;
  element.setAttribute("data-revealed", "");
  element.addEventListener("animationend", () => element.removeAttribute("data-revealed"), { once: true });
}

/**
 * What the preview's picker reports: the document and where in it (a block list's, or a `field()`
 * mark's whole path, with no index), then the block's index and the field in the block.
 */
export interface PreviewPick {
  source: { type: string, id: string, locale: string, path: Path } | null,
  index: number | null,
  field: Path
}

/**
 * Opens what was picked in the preview. Without a source (the site passed `<Blocks>` a list it built
 * itself), the block is taken to be in the open document's blocks, as "Show in preview" assumes.
 */
export function openPick(config: AnyConfig, readable: string[], editorPath: string, pick: PreviewPick) {
  const open = match("/content/:type/:id", editorPath);
  let type: string, id: string, list: Path;
  if(pick.source && readable.includes(pick.source.type)) {
    ({ type, id } = pick.source);
    list = pick.source.path;
    const locale = pick.source.locale && pick.source.locale !== config.defaultLocale ? `?locale=${encodeURIComponent(pick.source.locale)}` : "";
    if(open?.type !== type || open.id !== id) navigate(`/content/${type}/${id}${locale}`);
  } else {
    if(pick.index === null || !open || !readable.includes(open.type!)) return;
    ({ type, id } = open as { type: string, id: string });
    // The document's first list of blocks: a top-level array of a union.
    const shape = collectionSchema(config, type).shape;
    const field = Object.keys(shape).find(key => {
      let schema = shape[key]!;
      while(schema.type === "optional") schema = (schema as OptionalSchema).inner;
      return schema.type === "array" && (schema as ArraySchema).item.type === "union";
    });
    if(!field) return;
    list = [field];
  }
  // Leaving unsaved changes is the editor's call (it asks); if it stayed, there's nothing to show.
  const now = match("/content/:type/:id", location.pathname.replace(/^.*?\/content\//, "/content/"));
  if(now?.type !== type || now.id !== id) return;
  revealField([...list, ...(pick.index === null ? [] : [pick.index]), ...pick.field]);
}
