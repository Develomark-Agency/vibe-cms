import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

export default defineConfig({
  schemas: {
    author: v.object({
      name: v.text({ min: 1 })
    }),
    category: v.object({
      name: v.text({ min: 1 }),
      parent: v.optional(v.ref("category"))
    }),
    post: v.object({
      title: v.text({ min: 1 }),
      // Stores the author's ID. `indexed` speeds up filtering by it.
      author: v.ref("author", { indexed: true }),
      categories: v.array(v.ref("category")),
      // No target type: stores `{ type, id }` and can point at any document.
      featured: v.optional(v.ref())
    })
  }
});
