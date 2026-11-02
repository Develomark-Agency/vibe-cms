import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

// How content types appear in the editor. Every key and placeholder is checked against the schemas.
export default defineConfig({
  schemas: {
    article: v.object({
      headline: v.text({ min: 1 }),
      slug: v.text({ format: "slug", unique: true }),
      body: v.text({ multiline: true })
    }),
    faq: v.object({
      question: v.text(),
      answer: v.text({ multiline: true })
    }),
    settings: v.object({
      footerText: v.optional(v.text()),
      newsletterUrl: v.optional(v.text({ format: "url" }))
    })
  },
  collections: {
    // `title` names the text field shown in lists; `preview` is where the draft preview opens it.
    article: { label: "Articles", icon: "newspaper", title: "headline", preview: "/articles/{slug}" },
    faq: { label: "FAQ", icon: "message-square", title: "question" },
    // One document only: the editor opens it directly instead of listing documents.
    settings: { label: "Site content", icon: "settings", singleton: true }
  }
});
