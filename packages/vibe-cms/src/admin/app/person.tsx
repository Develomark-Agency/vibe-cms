import { cn } from "../lib/utils.ts";

/** A hue from someone's ID, so the same person has the same color everywhere, with nothing from their sign-in provider. */
export function personHue(id: string): number {
  let hash = 0;
  for(const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : name.slice(0, 2)).toUpperCase();
}

/** Someone's initials on their color. */
export function PersonFace({ id, name, className }: { id: string, name: string, className?: string }) {
  return (
    <span
      aria-hidden
      title={name}
      className={cn("inline-grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white ring-2 ring-background", className)}
      style={{ background: `hsl(${personHue(id)} 45% 46%)` }}
    >
      {initials(name)}
    </span>
  );
}

/** Up to `max` faces, overlapping, then "+N". */
export function PersonFaces({ people, max = 3, count = true, className }: { people: Array<{ id: string, name: string }>, max?: number, count?: boolean, className?: string }) {
  const shown = people.slice(0, max);
  return (
    <span className={cn("inline-flex shrink-0 items-center", className)} title={people.map(p => p.name).join(", ")}>
      {shown.map((person, i) => <PersonFace key={person.id} id={person.id} name={person.name} className={i ? "-ml-1.5" : undefined} />)}
      {count && people.length > max && <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">+{people.length - max}</span>}
    </span>
  );
}
