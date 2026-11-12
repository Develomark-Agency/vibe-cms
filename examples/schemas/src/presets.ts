import { blocks, defineBlock, pageSchema } from "vibe-cms/blocks";
import { richText } from "vibe-cms/rich-text";
import { defineConfig } from "vibe-cms";
import { image } from "vibe-cms/media";
import v from "vibe-cms/schema";

// A block is a named object schema; the site renders it with its own component.
export const Callout = defineBlock({
  type: "callout",
  label: "Callout",
  icon: "megaphone",
  fields: {
    text: v.text({ multiline: true }),
    tone: v.enum(["info", "warning"])
  }
});

export default defineConfig({
  collections: {
    post: {
      schema: v.object({
        title: v.text(),
        // Rich text is an array of blocks and inline nodes, edited with a Tiptap widget.
        body: richText(),
        teaser: v.optional(richText({ toolbar: "minimal" })),
        // A block list as a field of your own.
        sidebar: blocks([Callout], { max: 3 })
      })
    },
    // A page with a title, a unique `path`, a search description and blocks (built-ins plus yours).
    page: {
      title: "title",
      preview: "{path}",
      schema: pageSchema({ blocks: [Callout] })
    },
    person: { schema: v.object({ name: v.text(), photo: v.optional(image()) }) }
  }
});
