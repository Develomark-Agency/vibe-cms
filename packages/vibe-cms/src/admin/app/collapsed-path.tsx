import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/ui/dropdown-menu.tsx";
import { cn } from "../lib/utils.ts";

/**
 * A path on one line that, when it doesn't fit, replaces folders in its middle with "…" (first and
 * last always stay), like `All files › nested › … › photos`. The last one truncates if even that
 * is too wide. With `onOpen`, the "…" opens a menu of the folders it hides.
 */
export function CollapsedPath<T>({ items, label, separator, renderItem, onOpen, className }: {
  items: T[],
  /** An item's name, for the "…" menu. */
  label(item: T): string,
  separator: ReactNode,
  renderItem(item: T, last: boolean): ReactNode,
  /** Opens a hidden item from the "…" menu; without it, "…" is plain text. */
  onOpen?(item: T): void,
  className?: string
}) {
  // A span, so it can sit inside text such as a dialog description.
  const box = useRef<HTMLSpanElement>(null);
  // How many items after the first are folded into "…".
  const [hidden, setHidden] = useState(0);
  const most = Math.max(0, items.length - 2);
  const key = items.map(label).join("\u0000");

  const observer = useRef<ResizeObserver | null>(null);
  // Bumped to measure again without changing what's folded.
  const [, remeasure] = useState(0);

  // A new path, or a new width, starts unfolded and folds until it fits. The parts are watched too:
  // names can widen after the first measure (a web font loading, say), with nothing re-rendering.
  useLayoutEffect(() => {
    setHidden(0);
    const el = box.current;
    if(!el) return;
    let width = el.clientWidth;
    observer.current = new ResizeObserver(() => {
      if(el.clientWidth !== width) {
        width = el.clientWidth;
        setHidden(0);
      }
      // Always measure again: when nothing was folded, setHidden(0) changes nothing, so React
      // wouldn't re-render and a path that no longer fits would stay unfolded.
      remeasure(n => n + 1);
    });
    observer.current.observe(el);
    void document.fonts?.ready.then(() => remeasure(n => n + 1));
    return () => {
      observer.current?.disconnect();
      observer.current = null;
    };
  }, [key]);
  useLayoutEffect(() => {
    const el = box.current;
    if(!el) return;
    for(const child of el.children) observer.current?.observe(child);
    if(hidden < most && el.scrollWidth > el.clientWidth + 1) setHidden(hidden + 1);
  });

  const shown = hidden === 0
    ? items.map((item, index) => ({ item, index }))
    : [{ item: items[0]!, index: 0 }, null, ...items.slice(1 + hidden).map((item, i) => ({ item, index: 1 + hidden + i }))];
  const folded = items.slice(1, 1 + hidden);

  return (
    <span ref={box} className={cn("flex min-w-0 items-center overflow-hidden whitespace-nowrap", className)}>
      {shown.map((entry, i) => {
        const last = entry?.index === items.length - 1;
        return (
          <Fragment key={entry ? entry.index : "…"}>
            {i > 0 && <span className="flex shrink-0 items-center">{separator}</span>}
            {entry === null ? (
              onOpen ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`${folded.length} more`}
                    title={folded.map(label).join(" / ")}
                    className="shrink-0 rounded-[8px] px-1.5 py-1 hover:bg-foreground/[0.05] hover:text-foreground"
                  >
                    …
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    {folded.map((item, j) => <DropdownMenuItem key={j} onClick={() => onOpen(item)}>{label(item)}</DropdownMenuItem>)}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <span className="shrink-0" title={folded.map(label).join(" / ")}>…</span>
              )
            ) : (
              // Everything holds its width; the last truncates only once the middle is all folded, or it
              // would shrink to fit and the path would never look too wide to fold.
              <span className={cn("flex", last && hidden >= most ? "min-w-0" : "shrink-0")}>{renderItem(entry.item, last)}</span>
            )}
          </Fragment>
        );
      })}
    </span>
  );
}
