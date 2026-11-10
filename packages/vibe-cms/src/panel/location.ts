import { useSyncExternalStore } from "react";

// --- Location ---------------------------------------------------------------------

export const listeners = new Set<() => void>();

export function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

export function go(path: string) {
  history.pushState(null, "", path);
  listeners.forEach(l => l());
}

/**
 * Where the panel is: a framed site (`/s/:id/…`), a site's access page (`/sites/:id/access`), or one
 * of the panel's own pages (`/people`, `/templates`, `/review`). Anything else is the site list.
 */
export function useRoute(): { siteId: string | null, rest: string, page: "people" | "templates" | "review" | null, accessId: string | null } {
  const path = useSyncExternalStore(subscribe, () => location.pathname + location.search);
  const site = /^\/s\/([^/?]+)(.*)$/.exec(path);
  if(site) return { siteId: decodeURIComponent(site[1]!), rest: site[2] || "/", page: null, accessId: null };
  const access = /^\/sites\/([^/?]+)\/access/.exec(path);
  if(access) return { siteId: null, rest: "/", page: null, accessId: decodeURIComponent(access[1]!) };
  const page = /^\/(people|templates|review)\/?(\?|$)/.exec(path)?.[1] as "people" | "templates" | "review" | undefined;
  return { siteId: null, rest: "/", page: page ?? null, accessId: null };
}
