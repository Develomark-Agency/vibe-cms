import { Button } from "vibe-cms/admin/ui";
import { defineReactWidget } from "vibe-cms/admin/react";
import type { RatingOptions } from "./rating.ts";

// Rendered inside the editor's React tree, so the editor's components work here.
export default defineReactWidget<number | undefined, RatingOptions>(({ value, onChange, options, field }) => {
  const max = options.max ?? 5;
  return (
    <div>
      {Array.from({ length: max }, (_, i) => i + 1).map(n => (
        <Button key={n} type="button" size="sm" variant={value === n ? "default" : "outline"} disabled={field.readOnly} onClick={() => onChange(n)}>
          {n}
        </Button>
      ))}
      {/* An optional field is cleared with `undefined`. */}
      {!field.required && value !== undefined && <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>Clear</Button>}
    </div>
  );
});
