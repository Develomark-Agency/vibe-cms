import { defineConfig } from "../src/index.ts";
import { image } from "../src/media/index.ts";
import v from "../src/schema/index.ts";
import { definePlugin } from "../src/descriptor.ts";

export const calls: string[] = [];

export const AuditPlugin = definePlugin()((options: { tag: string }) => ({
  name: "audit",
  options,
  server: () => import("./audit.server.ts")
}));

export const config = defineConfig({
  locales: ["en", "fr"],
  plugins: [AuditPlugin({ tag: "t" })],
  permissions: {
    roles: {
      editor: { post: ["read", "write"], author: ["read"], publish: false },
      translator: { "*": ["read"], write: { locales: ["fr"] } }
    }
  },
  schemas: {
    author: v.object({
      name: v.text({ min: 1 }),
      email: v.optional(v.text({ format: "email" }))
    }),
    post: v.object({
      title: v.text({ min: 1, max: 120 }),
      slug: v.text({ indexed: true, format: "slug", unique: true }),
      publishedAt: v.optional(v.date({ indexed: true })),
      tags: v.array(v.text()),
      layout: v.enum(["default", "wide"]),
      author: v.optional(v.ref("author")),
      related: v.optional(v.array(v.ref("post"))),
      cover: v.optional(image({ minWidth: 100 })),
      seo: v.optional(v.object({ description: v.text({ max: 160 }) })),
      // Derived by the audit plugin on every write.
      searchText: v.optional(v.text({ hidden: true }))
    })
  }
});
