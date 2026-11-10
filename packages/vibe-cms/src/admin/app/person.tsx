import { UserRoundIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.tsx";
import { cn } from "../lib/utils.ts";

/** A hue from someone's ID, so the same person has the same color everywhere, with nothing from their sign-in provider. */
export function personHue(id: string): number {
  let hash = 0;
  for(const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

/** "Ada Lovelace" → "AL"; a one-word name is one letter, so "Ada" reads as "A", not a shouted "AD". */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if(!words.length) return "?";
  return (words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : words[0]![0]!).toUpperCase();
}

/** Someone in a list of faces. `self` is the person looking: they get a marker of their own, not initials. */
export interface FacePerson {
  id: string,
  name: string,
  self?: boolean
}

/** Someone's initials on their color; for yourself, a person icon in the accent color. */
export function PersonFace({ id, name, self, className }: FacePerson & { className?: string }) {
  if(self) {
    return (
      <span aria-hidden title="You" className={cn("inline-grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground ring-2 ring-background", className)}>
        <UserRoundIcon className="size-3" strokeWidth={2.5} />
      </span>
    );
  }
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

/** Up to `max` faces, overlapping, then "+N". Hovering lists everyone, in full. */
export function PersonFaces({ people, max = 3, count = true, className }: { people: FacePerson[], max?: number, count?: boolean, className?: string }) {
  const shown = people.slice(0, max);
  return (
    <Tooltip>
      <TooltipTrigger render={
        <span className={cn("inline-flex shrink-0 items-center", className)}>
          {shown.map((person, i) => <PersonFace key={person.id} {...person} className={i ? "-ml-1.5" : undefined} />)}
          {count && people.length > max && <span className="ml-1 text-[11px] text-muted-foreground tabular-nums">+{people.length - max}</span>}
        </span>
      } />
      <TooltipContent className="max-h-72 overflow-y-auto">
        <ul className="flex flex-col gap-1">
          {people.map(person => (
            <li key={person.id} className="flex items-center gap-2">
              <PersonFace {...person} className="size-4 text-[8px] ring-0" />
              {person.self ? "You" : person.name}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
