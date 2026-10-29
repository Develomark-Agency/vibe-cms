import { defineWidget } from "vibe-cms";

export interface ColorPickerOptions {
  swatches?: string[]
}

// The descriptor is plain data, safe for the Worker; the implementation is admin-only.
export const ColorPicker = defineWidget<string, ColorPickerOptions>({
  id: "example-blog:color-picker",
  admin: () => import("./color-picker.admin.ts")
});
