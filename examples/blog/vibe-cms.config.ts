import { richText } from "@vibe-cms/rich-text";
import { defineConfig } from "vibe-cms";
import { oidc } from "vibe-cms/auth";
import { image } from "vibe-cms/media";
import v from "vibe-cms/schema";
import { ViewsPlugin } from "./src/plugins/views/index.ts";
import { ColorPicker } from "./src/widgets/color-picker.ts";

export default defineConfig({
  id: "example-blog",
  name: "Vibe Blog",
  locales: ["en", "fr"],
  defaultLocale: "en",
  plugins: [ViewsPlugin({ types: ["post"] })],
  auth: oidc({
    issuer: "https://accounts.google.com",
    clientId: "1234.apps.googleusercontent.com"
  }),
  permissions: {
    roles: {
      "agency-staff": { all: true },
      "client-editor": { post: ["read", "write"], author: ["read"], settings: ["read", "write"], publish: false }
    },
    users: {
      "jane@my-agency.com": ["agency-staff"]
    }
  },
  collections: {
    post: { icon: "newspaper", preview: "/posts/{slug}" },
    author: { icon: "user-round" },
    settings: { singleton: true, label: "Site settings", icon: "settings" }
  },
  schemas: {
    post: v.object({
      title: v.text({ min: 1, max: 120 }),
      slug: v.text({ indexed: true, format: "slug", min: 1 }),
      excerpt: v.optional(v.text({ max: 280, multiline: true })),
      publishedAt: v.date({ indexed: true }),
      author: v.ref("author", { indexed: true }),
      cover: v.optional(image({ minWidth: 600, folder: "posts/covers" })),
      tags: v.array(v.text()),
      layout: v.enum(["default", "wide"]),
      body: richText(),
      seo: v.optional(v.object({
        description: v.text({ max: 160 })
      }))
    }),
    author: v.object({
      name: v.text({ min: 1 }),
      email: v.optional(v.text({ format: "email" })),
      bio: v.optional(richText({ toolbar: "minimal" })),
      avatar: v.optional(image({ alt: "optional", aspectRatio: 1 }))
    }),
    settings: v.object({
      title: v.text({ min: 1 }),
      tagline: v.optional(v.text()),
      accent: v.text({ widget: ColorPicker({ swatches: ["#6d28d9", "#0f766e", "#be123c", "#1d4ed8", "#c2410c"] }) })
    })
  }
});
