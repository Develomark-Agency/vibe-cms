import { useEffect, useLayoutEffect, useMemo, type ComponentProps } from "react";
import {
  createBrowserRouter,
  Link as RouterLink,
  matchPath,
  useBlocker,
  useLocation as useRouterLocation,
  useParams as useRouterParams,
  type RouteObject
} from "react-router";
import { onPanelNavigate, postToPanel } from "./session.ts";

/**
 * The editor's routing runs on React Router (data mode): history, matching, params, links,
 * the unsaved-changes guard (`useBlocker`) and page transitions (`viewTransition`). What it
 * adds here is the editor's look for those transitions (direction of travel, header pieces
 * that hold still) and scroll memory for the page's own scrolling panel.
 */
type AdminRouter = ReturnType<typeof createBrowserRouter>;

let router: AdminRouter | undefined;
let routerSource: unknown;
/** The page on screen, to tell which way a navigation goes and whether only the query changed. */
let current = "/";

/**
 * The editor's router, mounted at `basename` (`/_vibe/admin`). One per page load: asking again
 * for the same `source` (StrictMode renders twice) returns the router already made.
 */
export function createAdminRouter(basename: string, source: unknown, routes: () => RouteObject[]): AdminRouter {
  if(router && routerSource === source && router.basename === basename) return router;
  router?.dispose();
  routerSource = source;
  router = createBrowserRouter(routes(), { basename });
  current = stripBasename(router.state.location.pathname);
  // Subscribed before <RouterProvider>, so this runs before it starts the view transition.
  router.subscribe((state, { viewTransitionOpts }) => {
    // The router's own state keeps the basename; pages see paths without it.
    const to = stripBasename(state.location.pathname);
    if(to === current) return;
    rememberScroll();
    if(viewTransitionOpts) prepareTransition(current, to, state.historyAction === "POP" ? savedScroll(state.location.key) : 0);
  });
  return router;
}

function stripBasename(pathname: string): string {
  const base = router?.basename ?? "/";
  if(base === "/" || !pathname.startsWith(base)) return pathname;
  return pathname.slice(base.length) || "/";
}

// --- Scroll positions, per history entry ---------------------------------------------

/**
 * React Router's <ScrollRestoration> restores the window's scroll; the editor scrolls inside
 * `[data-scroll-root]` (main.tsx), so positions are kept here, by location key.
 */
const SCROLL_KEY = "vibe-admin:scroll";
const scrolls = new Map<string, number>(readScrolls());
let shownKey: string | undefined;

function readScrolls(): Array<[string, number]> {
  try {
    return JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? "[]") as Array<[string, number]>;
  } catch {
    return [];
  }
}

/** Remembers how far the page on screen is scrolled, before it's replaced. */
function rememberScroll() {
  if(!shownKey) return;
  scrolls.set(shownKey, scrollRoot()?.scrollTop ?? 0);
  try {
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify([...scrolls].slice(-100)));
  } catch {
    // Private windows and full storage: positions then only last for this page load.
  }
}

function savedScroll(key: string) {
  return scrolls.get(key) ?? 0;
}

function scrollRoot() {
  return document.querySelector<HTMLElement>("[data-scroll-root]");
}

// --- Page transitions ---------------------------------------------------------------

/** Drilling into a page below this one, going back up to one above it, or moving across. */
function direction(from: string, to: string): "forward" | "back" | "lateral" {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  function within(outer: string[], inner: string[]) {
    return outer.length > 0 && outer.length < inner.length && outer.every((s, i) => s === inner[i]);
  }
  return within(a, b) ? "forward" : within(b, a) ? "back" : "lateral";
}

/** A mask the size of the window, open everywhere except over these elements (their rounded boxes). */
function maskOut(elements: HTMLElement[]): string {
  const holes = elements.map(el => {
    const r = el.getBoundingClientRect();
    const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
    return `<rect x="${r.left}" y="${r.top}" width="${r.width}" height="${r.height}" rx="${radius}" fill="black"/>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${innerWidth}" height="${innerHeight}"><rect width="100%" height="100%" fill="white"/>${holes.join("")}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Page header pieces (`data-shared`) that sibling pages have in common, by name. */
function sharedPieces() {
  return new Map([...document.querySelectorAll<HTMLElement>("[data-shared]")].map(el => [el.dataset.shared!, el]));
}

/** What the leaving page's header said, to tell which pieces change; set while a transition is pending. */
let pending: { headers: Map<string, string | null> } | undefined;
let transitions = 0;

/** Safari's swipe-back animates the page itself; a second animation would repeat it. */
let swipedBack = false;
window.addEventListener("popstate", (event: PopStateEvent & { hasUAVisualTransition?: boolean }) => {
  swipedBack = event.hasUAVisualTransition === true;
});

type ViewTransitionDocument = Document & { activeViewTransition?: ViewTransition | null };

/**
 * Before React Router starts a view transition (styles.css): the direction of travel, the
 * leaving page's snapshot, the clip and mask, and whether header pieces hold still.
 */
function prepareTransition(from: string, to: string, scrollTop: number) {
  const html = document.documentElement;
  const nav = direction(from, to);
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
  // Floating windows (the draft preview) stay above the pages: the snapshots get a hole where each one is.
  const above = [...document.querySelectorAll<HTMLElement>("[data-above-transitions]")];
  if(above.length) html.style.setProperty("--transition-mask", maskOut(above));
  // Header pieces stay in place across sibling pages, when both are scrolled alike (otherwise they'd fly between
  // the two positions); the ones whose text differs hand over rather than cross-fade.
  if(nav === "lateral" && (panel?.scrollTop ?? 0) === scrollTop) html.dataset.holdHeader = "";
  pending = { headers: new Map([...sharedPieces()].map(([name, el]) => [name, el.textContent])) };
}

/** Once the arriving page is on screen (inside React Router's transition callback): its snapshot, and cleanup after. */
function finishTransition() {
  const html = document.documentElement;
  const { headers } = pending!;
  pending = undefined;
  const id = ++transitions;
  html.dataset.capture = "new";
  const changed: HTMLElement[] = [];
  for(const [name, el] of sharedPieces()) {
    if(headers.has(name) && headers.get(name) !== el.textContent) {
      el.style.setProperty("view-transition-class", "changed");
      changed.push(el);
    }
  }
  function cleanUp() {
    changed.forEach(el => el.style.removeProperty("view-transition-class"));
    if(id !== transitions) return;
    delete html.dataset.navigation;
    delete html.dataset.capture;
    delete html.dataset.holdHeader;
    html.style.removeProperty("--panel-clip");
    html.style.removeProperty("--transition-mask");
  }
  const active = (document as ViewTransitionDocument).activeViewTransition;
  if(active) {
    if(swipedBack) active.skipTransition();
    void active.finished.catch(() => {}).finally(cleanUp);
  } else {
    // Without `document.activeViewTransition`: once the transition's animations are running, wait for
    // them (only those: the page may have endless ones, like spinners). None means there's no transition.
    requestAnimationFrame(() => {
      const running = html.getAnimations({ subtree: true })
        .filter(a => (a.effect as KeyframeEffect | null)?.pseudoElement?.startsWith("::view-transition"));
      void Promise.allSettled(running.map(a => a.finished)).then(cleanUp);
    });
  }
}

/**
 * Rendered once, by the root route. After each page change: finishes its transition, then puts
 * the panel at the top for a new page, or where it was left for back/forward.
 */
export function usePageTransitions() {
  const location = useRouterLocation();
  useLayoutEffect(() => {
    const changed = location.pathname !== current;
    current = location.pathname;
    shownKey = location.key;
    if(pending) finishTransition();
    if(changed) {
      const root = scrollRoot();
      if(root) root.scrollTop = router?.state.historyAction === "POP" ? savedScroll(location.key) : 0;
    }
    swipedBack = false;
  }, [location.key]);
}

// --- Unsaved changes ----------------------------------------------------------------

/** Guards navigation away from unsaved changes: true (or a promise of true) lets it go ahead. */
let blocker: (() => boolean | Promise<boolean>) | undefined;

export function setNavigationBlocker(fn: (() => boolean | Promise<boolean>) | undefined) {
  blocker = fn;
}

/** Rendered once, by the root route: asks the page's guard before any navigation, back/forward included. */
export function useNavigationGuard() {
  const blocked = useBlocker(() => blocker !== undefined);
  useEffect(() => {
    if(blocked.state !== "blocked") return;
    const guard = blocker;
    if(!guard) return blocked.proceed();
    void Promise.resolve(guard()).then(ok => {
      if(!ok) return blocked.reset();
      // Leaving drops the edits, so the guard goes with them.
      if(blocker === guard) blocker = undefined;
      blocked.proceed();
    });
  }, [blocked]);
}

// --- Navigating ---------------------------------------------------------------------

/** Animates only when the page changes: sorting, paging and the locale (the query) don't. */
function changesPage(to: string) {
  return (to.split(/[?#]/)[0] || "/") !== current;
}

/** Resolves once the page transition that's running, if any, has finished: for things that should wait for the new page to be on screen. */
export function pageSettled(): Promise<void> {
  const active = (document as ViewTransitionDocument).activeViewTransition;
  return active ? active.finished.then(() => {}, () => {}) : Promise.resolve();
}

/** Opens an editor path, without the `/_vibe/admin` base: `/content/post/doc_123?locale=fr`. For code outside React. */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  const target = to.startsWith("/") ? to : `/${to}`;
  void router?.navigate(target, { replace: options.replace, viewTransition: changesPage(target) });
}

export function Link({ to, ...props }: Omit<ComponentProps<typeof RouterLink>, "to"> & { to: string }) {
  const { pathname } = useRouterLocation();
  return <RouterLink to={to} viewTransition={(to.split(/[?#]/)[0] || "/") !== pathname} {...props} />;
}

// --- Hooks --------------------------------------------------------------------------

export function useLocation(): { path: string, search: URLSearchParams, href: string } {
  const { pathname, search } = useRouterLocation();
  return useMemo(() => ({ path: pathname, search: new URLSearchParams(search), href: pathname + search }), [pathname, search]);
}

/** The current route's params: `:type`, `:id`, and `*` for a splat. */
export function useParams(): Record<string, string> {
  return useRouterParams() as Record<string, string>;
}

/** Matches an editor path against a route pattern (`/content/:type/:id`, `/p/search/*`). For code outside React. */
export function match(pattern: string, path: string): Record<string, string> | null {
  return (matchPath({ path: pattern, end: true }, path)?.params as Record<string, string> | undefined) ?? null;
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

history.scrollRestoration = "manual";
