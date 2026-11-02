import { cn } from "../lib/utils.ts";

/**
 * A site's mark, the same in the editor and the panel: its icon, else its favicon, else the first
 * letter of its name. The letter sits on `color` when given, else on the brand accent. Callers set size and radius.
 */
export function SiteMark({ name, icon, color, className }: { name: string, icon?: string | null, color?: string, className?: string }) {
  if(icon) return <img src={icon} alt="" className={cn("aspect-square shrink-0 object-cover shadow-(--shadow-raised)", className)} />;
  return (
    <span
      className={cn("flex aspect-square shrink-0 items-center justify-center font-semibold", color ? "text-white shadow-(--shadow-raised)" : "raised-brand", className)}
      style={color ? { background: color } : undefined}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
