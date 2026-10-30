import { createContext, useContext, useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { onPanelNavigate, postToPanel } from "./session.ts";

const listeners = new Set<() => void>();
let base = "/_vibe/admin";

export function setBase(next: string) {
  base = next.replace(/\/$/, "");
}

function emit() {
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** The editor-relative location, e.g. `/content/post/doc_123?locale=fr`. */
function snapshot(): string {
  const path = location.pathname.startsWith(base) ? location.pathname.slice(base.length) : location.pathname;
  return (path || "/") + location.search;
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

/**
 * Moving to another page animates through the View Transitions API (see
 * styles.css); changing only the query string (sorting, paging, locale) doesn't.
 */
function emitWithTransition(pageChanged: boolean) {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if(!pageChanged || reduced || !document.startViewTransition || document.hidden) return emit();
  const transition = document.startViewTransition(() => flushSync(emit));
  // A transition skipped by the browser (hidden tab, another one starting) still updates the DOM.
  transition.ready.catch(() => {});
  transition.finished.catch(() => {});
}

export function navigate(to: string, options: { replace?: boolean } = {}) {
  if(blocker && !blocker()) return;
  const url = base + (to.startsWith("/") ? to : `/${to}`);
  const pageChanged = new URL(url, location.href).pathname !== location.pathname;
  if(options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  emitWithTransition(pageChanged);
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
