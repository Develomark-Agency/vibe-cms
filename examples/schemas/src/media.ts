import { defineConfig } from "vibe-cms";
import { file, image, video } from "vibe-cms/media";
import v from "vibe-cms/schema";

export default defineConfig({
  collections: {
    product: {
      schema: v.object({
        name: v.text({ min: 1 }),
        // Stores `{ asset, alt, focal? }`; queries add `url`, `width`, `height`, `mime`, …
        photo: image({ minWidth: 800, aspectRatio: 4 / 3, folder: "products" }),
        gallery: v.array(image({ alt: "optional" }), { max: 12 }),
        demo: v.optional(video({ maxSize: "200MB", maxDuration: 120 })),
        manual: v.optional(file({ accept: ["application/pdf"], maxSize: "20MB" })),
        // The primitive the presets are built on: any file type, with your own per-usage fields.
        download: v.optional(v.asset({
          accept: ["application/zip"],
          maxSize: "50MB",
          fields: { version: v.text(), notes: v.optional(v.text({ multiline: true })) }
        }))
      })
    }
  }
});
