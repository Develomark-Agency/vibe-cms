import { defineConfig, type RoleRules } from "vibe-cms";
import v from "vibe-cms/schema";

// Every document can have a translation per locale. Queries in another locale fall back
// to the default locale's version for documents that aren't translated yet.
export default defineConfig({
  locales: ["en", "fr", "de"],
  defaultLocale: "en",
  collections: {
    page: {
      schema: v.object({
        title: v.text({ min: 1 }),
        path: v.text({ format: "path", unique: true }),
        body: v.text({ multiline: true })
      })
    }
  }
});

// Roles live in the site's database, edited on the editor's Roles page. This is a translator's
// rules there: reads everything, writes (translates) only French.
export const translator: RoleRules = { "*": ["read"], write: { locales: ["fr"] } };
