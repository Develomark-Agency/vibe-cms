import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

// A union of objects told apart by a literal `kind`: the editor shows a type picker,
// and narrowing on `kind` narrows the TypeScript type.
const link = v.union([
  v.object({ kind: v.literal("internal"), page: v.ref("page") }, { label: "Page on this site" }),
  v.object({ kind: v.literal("external"), url: v.text({ format: "url" }) }, { label: "Web address" }),
  v.object({ kind: v.literal("email"), address: v.text({ format: "email" }) }, { label: "Email" })
]);

export default defineConfig({
  schemas: {
    page: v.object({
      title: v.text(),
      path: v.text({ format: "path", unique: true })
    }),
    menu: v.object({
      name: v.text(),
      items: v.array(v.object({ label: v.text(), link }, { label: "Menu item" }))
    })
  }
});
