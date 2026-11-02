import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

export default defineConfig({
  collections: {
    post: { title: "title", preview: "/posts/{slug}" }
  },
  schemas: {
    post: v.object({
      title: v.text({ min: 1 }),
      slug: v.text({ format: "slug", indexed: true, unique: true }),
      body: v.text({ multiline: true })
    })
  }
});
