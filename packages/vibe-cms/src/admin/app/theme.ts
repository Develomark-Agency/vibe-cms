import { useSyncExternalStore } from "react";

/**
 * Switches the `dark` class with every CSS transition suppressed for that
 * frame, so the whole page changes at once instead of some parts fading and
 * others snapping.
 */
export function setDark(dark: boolean) {
  const root = document.documentElement;
  if(root.classList.contains("dark") === dark) return;
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.appendChild(style);
  root.classList.toggle("dark", dark);
  // Force the new styles to apply before transitions come back.
  void getComputedStyle(root).color;
  // A timeout rather than a frame: frames never come in a background tab.
  setTimeout(() => style.remove(), 1);
}

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "vibe:theme";
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

let current: Theme = typeof window === "undefined" ? "system" : stored();

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function apply() {
  setDark(current === "dark" || (current === "system" && matchMedia("(prefers-color-scheme: dark)").matches));
}

/** Applies the stored theme and follows the system setting while it's "system". Call once at startup. */
export function startTheme() {
  apply();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", apply);
}

export function getTheme(): Theme {
  return current;
}

/** The panel and the editors it frames keep this in step through the frame protocol. */
export function setTheme(theme: Theme) {
  if(theme === current) return;
  current = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows can refuse storage; the theme still applies for this page.
  }
  apply();
  listeners.forEach(listener => listener());
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  return [useSyncExternalStore(subscribeTheme, getTheme), setTheme];
}

/**
 * Points `--accent-source` at a `#rrggbb` colour; styles.css derives the brand
 * colour, its gradient, ring and foreground from it. null restores the neutral default.
 */
export function setAccent(accent: string | null) {
  const root = document.documentElement;
  if(accent) root.style.setProperty("--accent-source", accent);
  else root.style.removeProperty("--accent-source");
}

/** Shows `href` as the tab icon, or the default when null. */
export function setFavicon(href: string | null) {
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if(!href) {
    link?.remove();
    return;
  }
  if(!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = href;
}
