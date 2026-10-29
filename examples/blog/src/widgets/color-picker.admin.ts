import type { WidgetImpl } from "vibe-cms/admin";
import type { ColorPickerOptions } from "./color-picker.ts";

// A framework-neutral widget written straight against the `mount` contract.
const impl: WidgetImpl<string, ColorPickerOptions> = {
  mount(el, ctx) {
    el.className = "flex flex-wrap items-center gap-2";
    const input = document.createElement("input");
    input.type = "color";
    input.className = "h-9 w-12 cursor-pointer rounded-md border bg-transparent p-1";
    input.oninput = () => ctx.onChange(input.value);
    el.appendChild(input);
    const swatches = (ctx.options.swatches ?? []).map(color => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = color;
      button.className = "size-7 rounded-full border-2 border-transparent shadow-sm ring-1 ring-black/10 transition-transform hover:scale-110";
      button.style.background = color;
      button.onclick = () => ctx.onChange(color);
      el.appendChild(button);
      return button;
    });
    const label = document.createElement("code");
    label.className = "text-xs text-muted-foreground";
    el.appendChild(label);
    function render(value: string) {
      input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
      label.textContent = value || "No colour";
      for(const button of swatches) button.style.borderColor = button.title === value ? "var(--foreground)" : "transparent";
    }
    render(ctx.value);
    return {
      update(next) {
        ctx = next;
        render(next.value);
      },
      unmount() {
        el.replaceChildren();
      }
    };
  }
};

export default impl;
