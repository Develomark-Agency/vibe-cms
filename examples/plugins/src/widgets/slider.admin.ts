import type { WidgetImpl } from "vibe-cms/admin";
import { unwrapOptional, type NumberSchema } from "vibe-cms/schema";
import type { SliderOptions } from "./slider.ts";

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

export default slider;
