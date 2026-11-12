import type { ComponentProps, ReactNode } from "react";
import { cn } from "../lib/utils.ts";

/** The one width, padding and spacing every panel page sits in, so pages line up as you move between them. */
const FRAME = "mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 md:px-8";

/** The frame every panel page sits in. Anything beyond it (a drop target, a spacing tweak) passes through. */
export function Page({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn(FRAME, className)} {...props} />;
}

/** `Page` as a `<form>`, for settings pages that save as one. */
export function PageForm({ className, ...props }: ComponentProps<"form">) {
  return <form className={cn(FRAME, className)} {...props} />;
}

/**
 * The title block at the top of every page. Its pieces are the ones that hold still when you move between pages
 * (`data-shared`, see router.tsx), so all pages keep them the same size and place: a small label above, the
 * title, a line of detail below (always reserved, so the title never shifts), and actions on the right.
 */
export function PageHeader({ eyebrow, title, summary, actions }: { eyebrow: ReactNode, title: ReactNode, summary?: ReactNode, actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 space-y-1.5">
        <p className="eyebrow" data-shared="eyebrow">{eyebrow}</p>
        <h1 className="text-2xl font-medium tracking-[-0.025em]" data-shared="title">{title}</h1>
        <p className="min-h-5 text-sm text-muted-foreground" data-shared="summary">{summary ?? " "}</p>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2" data-shared="actions">{actions}</div>}
    </header>
  );
}
