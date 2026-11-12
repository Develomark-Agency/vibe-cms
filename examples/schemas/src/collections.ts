import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

// A content type's schema and how it appears in the editor sit together. Every placeholder is checked against its schema.
export default defineConfig({
  collections: {
    article: {
      // `title` names the text field shown in lists; `preview` is where the draft preview opens it.
      label: "Articles",
      icon: "newspaper",
      title: "headline",
      preview: "/articles/{slug}",
      schema: v.object({
        headline: v.text({ min: 1 }),
        slug: v.text({ format: "slug", unique: true }),
        body: v.text({ multiline: true })
      })
    },
    faq: {
      label: "FAQ",
      icon: "message-square",
      title: "question",
      schema: v.object({
        question: v.text(),
        answer: v.text({ multiline: true })
      })
    },
    settings: {
      label: "Site content",
      icon: "settings",
      // One document only: the editor opens it directly instead of listing documents.
      singleton: true,
      schema: v.object({
        footerText: v.optional(v.text()),
        newsletterUrl: v.optional(v.text({ format: "url" }))
      })
    }
  }
});
