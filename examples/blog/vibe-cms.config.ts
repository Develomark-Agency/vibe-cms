import { pageSchema } from "vibe-cms/blocks";
import { richText } from "vibe-cms/rich-text";
import { defineConfig } from "vibe-cms";
import { image } from "vibe-cms/media";
import v from "vibe-cms/schema";
import { ViewsPlugin } from "./src/plugins/views/index.ts";
import { ColorPicker } from "./src/widgets/color-picker.ts";
import { Features, Pricing, Testimonial } from "./src/blocks/definitions.ts";

export default defineConfig({
  locales: ["en", "fr"],
  defaultLocale: "en",
  plugins: [ViewsPlugin({ types: ["post"] })],
  collections: {
    post: {
      icon: "newspaper",
      preview: "/posts/{slug}",
      schema: v.object({
        title: v.text({ min: 1, max: 120 }),
        slug: v.text({ indexed: true, format: "slug", min: 1 }),
        excerpt: v.optional(v.text({ max: 280, multiline: true })),
        publishedAt: v.date({ indexed: true }),
        author: v.ref("author", { indexed: true }),
        cover: v.optional(image({ minWidth: 600, folder: "posts/covers" })),
        // A file readers can download with the post: slides, a PDF, a recording.
        attachment: v.optional(v.asset({ accept: ["application/pdf", "text/*", "video/*", "audio/*"], folder: "posts/files" })),
        tags: v.array(v.text()),
        layout: v.enum(["default", "wide"]),
        body: richText(),
        // Kept up to date by the views plugin on every write.
        readingMinutes: v.optional(v.number({ integer: true, label: "Reading time (minutes)", readOnly: true })),
        seo: v.optional(v.object({
          description: v.text({ max: 160 })
        }))
      })
    },
    author: {
      icon: "user-round",
      schema: v.object({
        name: v.text({ min: 1 }),
        email: v.optional(v.text({ format: "email" })),
        bio: v.optional(richText({ toolbar: "minimal" })),
        avatar: v.optional(image({ alt: "optional", aspectRatio: 1 })),
        // A framework-neutral widget, written against the plain `mount` contract.
        color: v.optional(v.text({ label: "Profile colour", widget: ColorPicker({ swatches: ["#6d28d9", "#0f766e", "#be123c", "#1d4ed8", "#c2410c"] }) }))
      })
    },
    // The site's name, accent and icon are built in (the editor's Site settings); this is the site's own content.
    homepage: {
      singleton: true,
      icon: "home",
      schema: v.object({
        tagline: v.optional(v.text())
      })
    },
    // The built-in blocks plus the site's own; see src/pages/[...path].astro for rendering.
    page: {
      icon: "layout",
      title: "title",
      preview: "{path}",
      schema: pageSchema({ blocks: [Testimonial, Features, Pricing] })
    }
  }
});
