import { Badge } from "../components/ui/badge.tsx";
import { cn } from "../lib/utils.ts";

export type Status = "draft" | "published" | "changed" | null | undefined;

const labels = { draft: "Draft", published: "Published", changed: "Unpublished changes" };

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
