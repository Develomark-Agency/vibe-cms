# Widgets

A widget is the admin UI for displaying and editing one field's value.

## Two files: descriptor and implementation

The descriptor is plain data and safe to import from the config (which the Worker also imports). The implementation lives in a `.admin.tsx` file that only the admin bundle ever loads (see [build.md](./build.md)).

```ts
// widgets/rich-editor.ts
import { defineWidget } from "vibe-cms";
import type { RichTextDoc } from "./types";

export interface RichEditorOptions {
  toolbar?: "minimal" | "full";
}

export const RichEditor = defineWidget<RichTextDoc, RichEditorOptions>({
  id: "@acme/rich-text:editor",
  admin: () => import("./rich-editor.admin"),
});
```

```tsx
// widgets/rich-editor.admin.tsx
import { defineReactWidget } from "vibe-cms/admin/react";
import { Tiptap } from "./tiptap";
import type { RichTextDoc } from "./types";
import type { RichEditorOptions } from "./rich-editor";

export default defineReactWidget<RichTextDoc, RichEditorOptions>(
  ({ value, onChange, options, field }) => (
    <Tiptap
      doc={value}
      onChange={onChange}
      toolbar={options.toolbar ?? "full"}
      invalid={field.errors.length > 0}
    />
  ),
);
```

## The core contract: `mount`

Under the hood, every widget implementation compiles to a framework-neutral `mount` function.

```ts
// vibe-cms/admin
export interface WidgetContext<T, O> {
  value: T;
  onChange(value: T): void;
  options: O;
  field: FieldDescriptor;   // schema info, label, validation errors
  cms: AdminClient;         // query content, upload assets, etc.
}

export interface WidgetImpl<T, O> {
  mount(el: HTMLElement, ctx: WidgetContext<T, O>): {
    update(ctx: WidgetContext<T, O>): void;
    unmount(): void;
  };
}
```

## React is the blessed path

The admin app is built in React. `defineReactWidget` is the first-class way to write widgets: React widgets render inside the admin's tree and get the design system, theme and form state for free.

Other frameworks can target `mount` directly, or through community adapters:

```ts
// widgets/color-picker.admin.ts
import { defineSolidWidget } from "vibe-cms-solid";
import { ColorPicker } from "./ColorPicker";

export default defineSolidWidget<string>((props) => (
  <ColorPicker value={props.value} onInput={props.onChange} />
));
```

```ts
// plain DOM, no framework
import type { WidgetImpl } from "vibe-cms/admin";

const impl: WidgetImpl<number, { step?: number }> = {
  mount(el, ctx) {
    const input = document.createElement("input");
    input.type = "range";
    input.step = String(ctx.options.step ?? 1);
    input.valueAsNumber = ctx.value;
    input.oninput = () => ctx.onChange(input.valueAsNumber);
    el.append(input);
    return {
      update(next) { input.valueAsNumber = next.value; },
      unmount() { input.remove(); },
    };
  },
};

export default impl;
```

The trade-off: React context (design system components, theme hooks, form state) does not cross the `mount` boundary. Non-React widgets work, but they are second-class by design.
