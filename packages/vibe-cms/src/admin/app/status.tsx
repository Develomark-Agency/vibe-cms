import { CircleCheckIcon, CircleDashedIcon, CircleDotIcon } from "lucide-react";
import { Badge } from "../components/ui/badge.tsx";
import { cn } from "../lib/utils.ts";

export type Status = "draft" | "published" | "changed" | null | undefined;

const labels = { draft: "Draft", published: "Published", changed: "Unpublished changes" };

/** "Published", "Unpublished changes", "Draft". */
export function statusLabel(status: Status): string {
  return status ? labels[status] : "Draft";
}

/**
 * The status as an icon, in `StatusDot`'s colours: a check when published, a dot in a ring when
 * there are unpublished changes, a dashed ring for a draft.
 */
export function StatusIcon({ status, className }: { status: Status, className?: string }) {
  const Icon = status === "published" ? CircleCheckIcon : status === "changed" ? CircleDotIcon : CircleDashedIcon;
  return (
    <Icon
      aria-label={statusLabel(status)}
      className={cn(
        "size-4 shrink-0",
        status === "published" && "text-emerald-500",
        status === "changed" && "text-amber-500",
        (status === "draft" || !status) && "text-muted-foreground/60",
        className
      )}
    />
  );
}

export function StatusDot({ status, className }: { status: Status, className?: string }) {
  return (
    <span
      title={status ? labels[status] : undefined}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        status === "published" && "bg-emerald-500",
        status === "changed" && "bg-amber-500",
        (status === "draft" || !status) && "bg-muted-foreground/40",
        className
      )}
    />
  );
}

export function StatusBadge({ status }: { status: Status }) {
  if(!status) return <Badge variant="outline" className="font-normal">New</Badge>;
  return (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <StatusDot status={status} />
      {labels[status]}
    </Badge>
  );
}
