import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

// Every document can have a translation per locale. Queries in another locale fall back
// to the default locale's version for documents that aren't translated yet.
export default defineConfig({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  schemas: {
    page: v.object({
      title: v.text({ min: 1 }),
      path: v.text({ format: "path", unique: true }),
      body: v.text({ multiline: true })
    })
  },
  permissions: {
    roles: {
      editor: { all: true },
      // Reads everything, writes (translates) only French.
      translator: { "*": ["read"], write: { locales: ["fr"] } }
    }
  }
});
