import type { ComponentType } from "react";
import { createRoot } from "react-dom/client";
import type { WidgetContext, WidgetImpl } from "./index.ts";

/**
 * The first-class way to write a widget. Rendered inside the admin's React
 * tree, so design system components, theme and form state just work.
 * Default-export the result from the widget's `*.admin.tsx` file.
 * See `vibe-cms docs widgets`.
 */
export function defineReactWidget<T, O = {}>(Component: ComponentType<WidgetContext<T, O>>): WidgetImpl<T, O> {
  return {
    react: Component,
    // Used only if a host renders outside React; the admin itself renders `react` directly.
    mount(el, ctx) {
      const root = createRoot(el);
      root.render(<Component {...ctx} />);
      return {
        update(next) {
          root.render(<Component {...next} />);
        },
        unmount() {
          root.unmount();
        }
      };
    }
  };
}

export type { WidgetContext, WidgetImpl };
