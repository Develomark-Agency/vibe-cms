import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

export interface SegmentedOption<T extends string> {
  value: T,
  label: ReactNode,
  disabled?: boolean
}

/**
 * A choice between a few options: a recessed track holding a raised pill.
 * Radii nest exactly: 3px of track padding around 10px pills makes a 13px track.
 */
export function Segmented<T extends string>({ options, value, onChange, disabled, label, id, className, fill }: {
  options: Array<SegmentedOption<T>>,
  value: T | undefined,
  onChange(value: T): void,
  disabled?: boolean,
  label?: string,
  id?: string,
  className?: string,
  /** Stretches to its container's width, each option growing with its label, never wrapping. */
  fill?: boolean
}) {
  return (
    <div role="radiogroup" aria-label={label} id={id} className={cn("inline-flex gap-0.5 rounded-[13px] well p-[3px]", fill ? "w-full flex-nowrap" : "w-fit flex-wrap", className)}>
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || option.disabled}
            onClick={() => {
              if(!selected) onChange(option.value);
            }}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-[10px] px-3 text-sm whitespace-nowrap text-muted-foreground transition-[color,box-shadow,background-color,scale] duration-150 ease-out",
              fill && "flex-auto justify-center px-2",
              "hover:text-foreground active:scale-[0.97] disabled:pointer-events-none disabled:opacity-40",
              "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
              selected && "raised font-medium text-foreground"
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
