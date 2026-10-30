import { lazy, Suspense, useSyncExternalStore } from "react";
import { cn } from "../lib/utils.ts";

function subscribeMedia(query: string) {
  return (onChange: () => void) => {
    const media = matchMedia(query);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  };
}

const reducedQuery = "(prefers-reduced-motion: reduce)";
const subscribeReduced = subscribeMedia(reducedQuery);

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => matchMedia(reducedQuery).matches);
}

function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

/** Follows the `dark` class the editor and panel set on <html>. */
export function useIsDark(): boolean {
  return useSyncExternalStore(subscribeTheme, () => document.documentElement.classList.contains("dark"));
}

/*
 * One material across the app: warm, low-contrast, slow. The shaders render
 * with WebGPU; without it the canvas stays transparent and the CSS gradient
 * underneath stands in. The cursor only moves the light: the satin's sheen
 * turns a little toward it, the aurora leans a little after it, both lagging.
 */
export const materials = {
  dark: {
    satin: { color: "#1c1715", highlight: "#5e3220" },
    aurora: { a: "#b8582a", b: "#5a2a18", c: "#1c1715" },
    fallback: "radial-gradient(120% 140% at 85% 0%, #43221a 0%, #191514 65%)"
  },
  light: {
    satin: { color: "#f1e9e1", highlight: "#f4c7a4" },
    aurora: { a: "#f7c49c", b: "#f3ddc9", c: "#f6f1ec" },
    fallback: "radial-gradient(120% 140% at 85% 0%, #f5d6bd 0%, #f6f1ec 65%)"
  }
};

// The shader library is large; it loads on its own, after the page.
const ShaderLayer = lazy(() => import("./shader-layer.tsx"));

/**
 * A backdrop that fills its parent: `satin` is draped fabric with a faint
 * sheen, for headers; `aurora` is a dim glow from above, for full screens.
 */
export function ShaderBackdrop({ variant = "satin", className }: { variant?: "satin" | "aurora", className?: string }) {
  const dark = useIsDark();
  const reduced = useReducedMotion();
  const m = dark ? materials.dark : materials.light;
  return (
    <div aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      <div className="absolute inset-0" style={{ background: m.fallback }} />
      <Suspense fallback={null}>
        <ShaderLayer variant={variant} dark={dark} reduced={reduced} />
      </Suspense>
      {/* Keeps text in the lower left legible whatever the material is doing. */}
      <div className="absolute inset-0 bg-[linear-gradient(to_top_right,var(--background)_10%,transparent_65%)] opacity-70" />
    </div>
  );
}
