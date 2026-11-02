import { defineWidget } from "vibe-cms";

export interface SliderOptions {
  step?: number
}

export const Slider = defineWidget<number, SliderOptions>({
  id: "example-plugins:slider",
  admin: () => import("./slider.admin.ts")
});
