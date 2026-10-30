import { useEffect, useState, type ReactNode } from "react";

/**
 * Renders its children only after `ms`. Wrap loading placeholders in it:
 * fast loads go straight to content instead of flashing a skeleton.
 */
export function Delayed({ children, ms = 300 }: { children: ReactNode, ms?: number }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return show ? children : null;
}

/**
 * `rise-in` for content that replaces a loading state, so it doesn't pop in.
 * Content that was ready on the first render gets nothing: the page
 * transition is already animating it.
 */
export function useArrival(ready: boolean): string {
  const [waited] = useState(!ready);
  return waited && ready ? "rise-in" : "";
}
