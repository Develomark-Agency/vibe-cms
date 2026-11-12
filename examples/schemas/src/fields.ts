import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";

// Every field type on one content type. Fields are required unless wrapped in `v.optional`.
export const event = v.object({
  title: v.text({ min: 1, max: 120 }),
  slug: v.text({ format: "slug", unique: true, indexed: true }),
  summary: v.optional(v.text({ multiline: true, max: 280, description: "Shown in listings" })),
  contact: v.optional(v.text({ format: "email" })),
  website: v.optional(v.text({ format: "url" })),
  code: v.optional(v.text({ pattern: "^[A-Z]{3}-\\d{3}$", label: "Event code" })),

  startsAt: v.date({ time: true, indexed: true }),
  endsOn: v.optional(v.date()),
  capacity: v.number({ integer: true, min: 1 }),
  price: v.optional(v.number({ min: 0, step: 0.01 })),
  online: v.boolean(),
  status: v.enum(["planned", "open", "full", "cancelled"], { labels: { open: "Open for sign-ups" }, indexed: true }),

  tags: v.array(v.text(), { max: 10 }),
  venue: v.optional(v.object({
    name: v.text(),
    address: v.text({ multiline: true })
  })),
  sessions: v.array(v.object({
    title: v.text(),
    minutes: v.number({ integer: true })
  }, { label: "Session" }), { label: "Programme" }),

  // Kept by code (a plugin or an import), not by editors.
  externalId: v.optional(v.text({ readOnly: true })),
  importedAt: v.optional(v.date({ time: true, hidden: true }))
});

export default defineConfig({
  collections: {
    event: { schema: event }
  }
});
