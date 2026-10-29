import { defineWidget } from "vibe-cms";
import v from "vibe-cms/schema";
import { block, type RichTextDoc } from "./schema.ts";

export * from "./schema.ts";
export { renderRichText, toPlainText } from "./render.ts";

export interface RichEditorOptions {
  /** `minimal`: marks and links only. `full` adds headings, lists, quotes and images. */
  toolbar?: "minimal" | "full",
  placeholder?: string
}

export const RichEditor = defineWidget<RichTextDoc, RichEditorOptions>({
  id: "@vibe-cms/rich-text:editor",
  admin: () => import("./editor.admin.tsx")
});

/** The rich text preset: a data shape built from primitives, paired with a default widget. */
export function richText(options: RichEditorOptions & { label?: string, description?: string } = {}) {
  const { label, description, ...widget } = options;
  return v.array(block, { label, description, widget: RichEditor(widget) });
}
