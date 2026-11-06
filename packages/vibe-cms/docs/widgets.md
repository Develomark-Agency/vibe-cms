# Widgets

Custom editor inputs for a field: a descriptor you put on the schema, and an implementation that loads only in the editor, written in React or against a plain `mount` contract.

Every field type has a built-in control. A widget replaces it for one field. It has two parts in two files, because the config (and so the descriptor) is imported by the Worker too:

| File | Holds |
|---|---|
| `rating.ts` | `defineWidget<Value, Options>({ id, admin })`: the descriptor factory. Plain data |
| `rating.admin.tsx` | The implementation, default-exported. Loaded by the editor the first time the widget is shown |

Widgets don't need a plugin: using one in a schema is enough for the editor to load it. The examples here are in `examples/plugins/src/widgets`.

## The descriptor

```ts
// examples/plugins/src/widgets/rating.ts
import { defineWidget } from "vibe-cms";

export interface RatingOptions {
  max?: number
}

// The descriptor: plain data, safe to import in the config and the Worker. The implementation loads only in the editor.
export const Rating = defineWidget<number, RatingOptions>({
  id: "example-plugins:rating",
  admin: () => import("./rating.admin.tsx")
});
```

- `id` is namespaced (`<package or site>:<widget>`) and unique. The editor caches implementations by it.
- The first type argument is the value the widget edits. Putting it on a field of another type is a type error.
- The second is its options, given per use. When every option is optional, calling `Rating()` without arguments works.

Use it through any field's `widget` option. On an optional field, put it on the inner schema:

```ts
// examples/plugins/vibe-cms.config.ts
      rating: v.optional(v.number({ integer: true, min: 1, max: 5, widget: Rating({ max: 5 }) })),
```

The schema still validates the value on the server; a widget only changes how it's edited. Field presets are built the same way: `image()` from `vibe-cms/media` is `v.asset()` with the built-in asset picker widget, and `richText()` from `vibe-cms/rich-text` is a schema with a Tiptap widget.

## A React widget

`defineReactWidget` from `vibe-cms/admin/react` renders the component inside the editor's React tree, so the editor's components (`vibe-cms/admin/ui`), theme and Tailwind classes work.

```tsx
// examples/plugins/src/widgets/rating.admin.tsx
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
```

Props (`WidgetContext`):

| Prop | |
|---|---|
| `value` | The field's current value. `undefined` when an optional field is empty, and possibly any stored JSON on a draft that doesn't validate |
| `onChange(value)` | Sets the value. `undefined` clears an optional field |
| `options` | What the schema passed to the descriptor factory |
| `field` | `name`, `path`, `label`, `schema` (as declared, so possibly the optional wrapper), `errors`, `required`, `readOnly`, `locale`, `document` |
| `cms` | The editor's client (`vibe-cms docs admin-extensions`): uploads, queries, plugin routes |

Respect `field.readOnly`: it's set for `readOnly` fields and for editors who may not write this locale. Validation messages are shown under the widget by the editor.

## A framework-neutral widget

Without React, implement `WidgetImpl` directly: `mount` draws into an element and returns `update` and `unmount`.

```ts
// examples/plugins/src/widgets/slider.admin.ts
// The framework-neutral contract: draw into `el`, call `onChange`, follow `update` until `unmount`.
const slider: WidgetImpl<number | undefined, SliderOptions> = {
  mount(el, ctx) {
    const input = document.createElement("input");
    input.type = "range";
    input.step = String(ctx.options.step ?? 1);
    input.oninput = () => ctx.onChange(Number(input.value));
    el.appendChild(input);
    function render(next: typeof ctx) {
      // `field.schema` is the field as declared; an optional field wraps the number schema.
      const schema = unwrapOptional(next.field.schema) as NumberSchema;
      input.min = String(schema.min ?? 0);
      input.max = String(schema.max ?? 100);
      input.value = String(next.value ?? schema.min ?? 0);
      input.disabled = next.field.readOnly;
    }
    render(ctx);
    return {
      update(next) {
        ctx = next;
        render(next);
      },
      unmount() {
        el.replaceChildren();
      }
    };
  }
};
```

`mount` is called once; `update` is called with a fresh context on every render of the form (keep using the newest `ctx`, since its `onChange` and `value` change); `unmount` when the field goes away. Use this to wrap a library written for another framework.

## Widgets in a package

Publish the descriptor from the package's main entry and keep the implementation in a `*.admin.*` file. Packages in the site's `package.json` that depend on `vibe-cms` are pre-bundled for the editor and are Tailwind sources, so their utility classes are generated.
