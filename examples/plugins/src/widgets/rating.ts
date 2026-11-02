import { defineWidget } from "vibe-cms";

export interface RatingOptions {
  max?: number
}

// The descriptor: plain data, safe to import in the config and the Worker. The implementation loads only in the editor.
export const Rating = defineWidget<number, RatingOptions>({
  id: "example-plugins:rating",
  admin: () => import("./rating.admin.tsx")
});
