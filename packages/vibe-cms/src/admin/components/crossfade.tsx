import type { ReactNode } from "react";

import { cn } from "../lib/utils";

/**
 * Swaps between a fixed set of labels in place. All of them sit in one grid
 * cell, so the container is as wide as the widest and never jumps, and the
 * active one fades in while the others fade out with a touch of blur: the blur
 * makes the two read as one thing changing rather than two passing through
 * each other. Reduced motion keeps the fade and drops the blur.
 */
export function Crossfade<K extends string>({ active, options, className }: {
  active: K,
  options: Record<K, ReactNode>,
  className?: string
}) {
  return (
    <span className={cn("grid items-center justify-items-center", className)}>
      {(Object.keys(options) as K[]).map(key => (
        <span
          key={key}
          aria-hidden={key !== active}
          className={cn(
            "col-start-1 row-start-1 inline-flex items-center gap-1 whitespace-nowrap transition-[opacity,filter] duration-200 ease-out motion-reduce:transition-opacity",
            key === active ? "opacity-100 blur-0" : "pointer-events-none opacity-0 blur-[2px] motion-reduce:blur-0"
          )}
        >
          {options[key]}
        </span>
      ))}
    </span>
  );
}
