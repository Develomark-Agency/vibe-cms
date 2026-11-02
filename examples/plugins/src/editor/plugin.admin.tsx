import { defineAdmin, type DocumentSlotProps, type DocumentSummary, type FieldDecoratorProps } from "vibe-cms/admin";
import { unwrapOptional, type AnySchema, type TextSchema } from "vibe-cms/schema";

function maxLength(schema: AnySchema): number | undefined {
  const inner = unwrapOptional(schema);
  return inner.type === "text" ? (inner as TextSchema).max : undefined;
}

// document.sidebar: a panel next to the form. `value` is the form's current (unsaved) data.
function WordsPanel({ value }: DocumentSlotProps) {
  return <p>{typeof value.wordCount === "number" ? `${value.wordCount} words` : "Counted on save"}</p>;
}

// list.columns: one cell per row of the post list.
function PinnedCell({ doc }: { doc: DocumentSummary }) {
  return <span>{doc.pinned ? "Pinned" : ""}</span>;
}

// fieldDecorators: wraps a field's control. Render `children` to keep the control itself.
function Remaining({ field, value, children }: FieldDecoratorProps) {
  const max = maxLength(field.schema)!;
  return <div>{children}<small>{max - (typeof value === "string" ? value.length : 0)} characters left</small></div>;
}

export default defineAdmin(({ cms }) => ({
  slots: {
    "document.sidebar": [{ id: "words", label: "Words", types: ["post"], component: WordsPanel }],
    // An action with `run` is a header button; give `component` instead to render your own.
    "document.actions": [{
      id: "copy-id",
      label: "Copy ID",
      types: ["post"],
      run: async ({ id }) => {
        if(!id) return cms.toast("Save the post first", { type: "error" });
        await navigator.clipboard.writeText(id);
        cms.toast("Copied", { type: "success" });
      }
    }],
    "list.columns": [{ type: "post", id: "pinned", label: "Pinned", component: PinnedCell }]
  },
  // Shown in the editor's command menu.
  commands: [{
    id: "editor.new-post",
    label: "New post",
    run: () => cms.navigate("/content/post/new")
  }],
  fieldDecorators: [{
    id: "remaining",
    match: field => maxLength(field.schema) !== undefined,
    component: Remaining
  }]
}));
