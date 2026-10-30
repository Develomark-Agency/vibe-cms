import { createContext, useContext, useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { onPanelNavigate, postToPanel } from "./session.ts";

const listeners = new Set<() => void>();
let base = "/_vibe/admin";
/** The page on screen, to tell which way a navigation goes. */
let current = location.pathname;

export function setBase(next: string) {
  base = next.replace(/\/$/, "");
  current = pagePath();
}

function emit() {
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The editor-relative path, e.g. `/content/post/doc_123`. */
function pagePath(): string {
  return (location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname) || "/";
}

/** The editor-relative location, e.g. `/content/post/doc_123?locale=fr`. */
function snapshot(): string {
  return pagePath() + location.search;
}

export function useLocation(): { path: string, search: URLSearchParams, href: string } {
  const href = useSyncExternalStore(subscribe, snapshot);
  const [path, query = ""] = href.split("?") as [string, string?];
  return { path, search: new URLSearchParams(query), href };
}

/** Guards navigation away from unsaved changes. */
let blocker: (() => boolean) | undefined;

export function setNavigationBlocker(fn: (() => boolean) | undefined) {
  blocker = fn;
}

/** The page's scrolling panel (main.tsx), which keeps its position across pages unless reset. */
function scrollRoot() {
  return document.querySelector<HTMLElement>("[data-scroll-root]");
}

/** Drilling into a page below this one, going back up to one above it, or moving across. */
function direction(from: string, to: string): "forward" | "back" | "lateral" {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  function within(outer: string[], inner: string[]) {
    return outer.length > 0 && outer.length < inner.length && outer.every((s, i) => s === inner[i]);
  }
  return within(a, b) ? "forward" : within(b, a) ? "back" : "lateral";
}

let transitions = 0;

/** Page header pieces (`data-shared`) that sibling pages have in common, by name. */
function sharedPieces() {
  return new Map([...document.querySelectorAll<HTMLElement>("[data-shared]")].map(el => [el.dataset.shared!, el]));
}

/**
 * Moving to another page animates through the View Transitions API (see
 * styles.css), in the direction of travel; changing only the query string
 * (sorting, paging, locale) doesn't. A new page starts at the top, and
 * back/forward returns to where that page was left.
 */
function emitWithTransition(scrollTop = 0, animate = true) {
  const from = current;
  current = pagePath();
  if(from === current) return emit();
  function update() {
    flushSync(emit);
    const root = scrollRoot();
    if(root) root.scrollTop = scrollTop;
  }
  if(!animate || !document.startViewTransition || document.hidden) return update();
  const html = document.documentElement;
  const id = ++transitions;
  const nav = direction(from, current);
  html.dataset.navigation = nav;
  // The page leaving and the page arriving are separate snapshots (styles.css), so neither travels from where the other was scrolled.
  html.dataset.capture = "old";
  // Snapshots are drawn above the document, outside the panel's rounded clip; styles.css clips them back to it.
  const panel = scrollRoot();
  if(panel) {
    const r = panel.getBoundingClientRect();
    const s = getComputedStyle(panel);
    html.style.setProperty("--panel-clip", `inset(${r.top}px ${innerWidth - r.right}px ${innerHeight - r.bottom}px ${r.left}px round ${s.borderTopLeftRadius} ${s.borderTopRightRadius} ${s.borderBottomRightRadius} ${s.borderBottomLeftRadius})`);
  }
  // Header pieces stay in place across sibling pages, when both are scrolled alike (otherwise they'd fly between
  // the two positions); the ones whose text differs hand over rather than cross-fade.
  if(nav === "lateral" && (panel?.scrollTop ?? 0) === scrollTop) html.dataset.holdHeader = "";
  const before = new Map([...sharedPieces()].map(([name, el]) => [name, el.textContent]));
  const changed: HTMLElement[] = [];
  const transition = document.startViewTransition(() => {
    update();
    html.dataset.capture = "new";
    for(const [name, el] of sharedPieces()) {
      if(before.has(name) && before.get(name) !== el.textContent) {
        el.style.setProperty("view-transition-class", "changed");
        changed.push(el);
      }
    }
  });
  // A transition skipped by the browser (hidden tab, another one starting) still updates the DOM.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {}).finally(() => {
    changed.forEach(el => el.style.removeProperty("view-transition-class"));
    if(id === transitions) {
      delete html.dataset.navigation;
      delete html.dataset.capture;
      delete html.dataset.holdHeader;
      html.style.removeProperty("--panel-clip");
    }
  });
}

history.scrollRestoration = "manual";

window.addEventListener("popstate", (event: PopStateEvent & { hasUAVisualTransition?: boolean }) => {
  // Safari's swipe-back already animated the page; a second animation would repeat it.
  emitWithTransition((history.state as { scroll?: number } | null)?.scroll ?? 0, !event.hasUAVisualTransition);
});

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if(blocker && !blocker()) return;
  const url = base + (to.startsWith("/") ? to : `/${to}`);
  // Remember where this page was scrolled to, for back/forward.
  if(!options.replace) history.replaceState({ ...history.state, scroll: scrollRoot()?.scrollTop ?? 0 }, "");
  if(options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  emitWithTransition();
}

export function useNavigationSync() {
  const { href } = useLocation();
  useEffect(() => {
    postToPanel({ type: "vibe:navigated", path: href });
  }, [href]);
  // Every page sets document.title; the panel mirrors it.
  useEffect(() => {
    const title = document.querySelector("title");
    if(!title) return;
    const observer = new MutationObserver(() => postToPanel({ type: "vibe:title", title: document.title }));
    observer.observe(title, { childList: true });
    postToPanel({ type: "vibe:title", title: document.title });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const off = onPanelNavigate(path => navigate(path, { replace: true }));
    return () => {
      off();
    };
  }, []);
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split("/").filter(Boolean);
  const got = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for(let i = 0; i < want.length; i++) {
    const segment = want[i]!;
    if(segment === "*") {
      params["*"] = got.slice(i).join("/");
      return params;
    }
    if(got[i] === undefined) return null;
    if(segment.startsWith(":")) params[segment.slice(1)] = decodeURIComponent(got[i]!);
    else if(segment !== got[i]) return null;
  }
  return want.length === got.length ? params : null;
}

export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if(event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
  }
  return <a href={base + to} onClick={handleClick} {...props} />;
}

export const ParamsContext = createContext<Record<string, string>>({});

export function useParams() {
  return useContext(ParamsContext);
}
