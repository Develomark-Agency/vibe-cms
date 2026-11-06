import { richText } from "../rich-text/index.ts";
import { image } from "../media/index.ts";
import v from "../schema/index.ts";
import { blocks, defineBlock, type BlockDefinition } from "./define.ts";

/*
 * The blocks every page gets. They're defined exactly like custom blocks, and
 * every adapter renders them as plain, JavaScript-free HTML unless you pass
 * your own component for the type.
 */

const buttons = v.array(
  v.object({
    label: v.text({ min: 1, max: 40 }),
    href: v.text({ min: 1, label: "Link", description: "A URL, or a path on this site like /contact" }),
    style: v.enum(["primary", "secondary"])
  }, { label: "Button" }),
  { max: 3, label: "Buttons" }
);

export const Hero = defineBlock({
  type: "hero",
  label: "Hero",
  icon: "megaphone",
  description: "A large heading with text, buttons and an optional image",
  fields: {
    eyebrow: v.optional(v.text({ max: 60, label: "Eyebrow", description: "A short line above the heading" })),
    heading: v.text({ min: 1, max: 120 }),
    text: v.optional(v.text({ multiline: true, max: 400 })),
    buttons,
    image: v.optional(image({ alt: "optional" })),
    align: v.enum(["left", "center"], { label: "Alignment" })
  }
});

export const Text = defineBlock({
  type: "text",
  label: "Text",
  icon: "file-text",
  description: "Paragraphs, headings, lists and links",
  fields: {
    body: richText()
  }
});

export const Image = defineBlock({
  type: "image",
  label: "Image",
  icon: "image",
  description: "A single image with an optional caption",
  fields: {
    image: image(),
    caption: v.optional(v.text({ max: 200 })),
    width: v.enum(["content", "wide", "full"], { label: "Width" })
  }
});

export const Gallery = defineBlock({
  type: "gallery",
  label: "Gallery",
  icon: "layout",
  description: "A grid of images",
  fields: {
    images: v.array(image({ alt: "optional" }), { min: 1, label: "Images" }),
    columns: v.enum(["3", "2", "4"], { label: "Columns" })
  }
});

export const CallToAction = defineBlock({
  type: "cta",
  label: "Call to action",
  icon: "sparkles",
  description: "A heading and buttons that ask the reader to do something",
  fields: {
    heading: v.text({ min: 1, max: 120 }),
    text: v.optional(v.text({ multiline: true, max: 300 })),
    buttons
  }
});

export const Quote = defineBlock({
  type: "quote",
  label: "Quote",
  icon: "quote",
  description: "A pull quote or testimonial",
  fields: {
    quote: v.text({ min: 1, multiline: true, max: 600 }),
    attribution: v.optional(v.text({ max: 80, label: "Who said it" })),
    role: v.optional(v.text({ max: 80, label: "Their role" }))
  }
});

export const Video = defineBlock({
  type: "video",
  label: "Video",
  icon: "film",
  description: "A YouTube or Vimeo video, or a video file",
  fields: {
    url: v.text({ min: 1, format: "url", label: "Video link", description: "A YouTube or Vimeo link, or the URL of a video file" }),
    caption: v.optional(v.text({ max: 200 }))
  }
});

export const Faq = defineBlock({
  type: "faq",
  label: "FAQ",
  icon: "message-square",
  description: "Questions with answers that open on click",
  fields: {
    heading: v.optional(v.text({ max: 120 })),
    items: v.array(
      v.object({ question: v.text({ min: 1, max: 200 }), answer: v.text({ min: 1, multiline: true }) }, { label: "Question" }),
      { min: 1, label: "Questions" }
    )
  }
});

export const Divider = defineBlock({
  type: "divider",
  label: "Divider",
  icon: "menu",
  description: "A line or some space between sections",
  fields: {
    style: v.enum(["line", "space"], { label: "Style" })
  }
});

export const builtInBlocks = [Hero, Text, Image, Gallery, CallToAction, Quote, Video, Faq, Divider] as const;

export type BuiltInBlock = typeof builtInBlocks[number];
export type BuiltInType = BuiltInBlock["type"];

export function isBuiltInType(type: string): type is BuiltInType {
  return builtInBlocks.some(block => block.type === type);
}

/**
 * A page: a title, the path it lives at, a search description and its blocks:
 * the built-ins plus your own. Use it as a collection's schema:
 *
 *     schemas: { page: pageSchema({ blocks: [Testimonial, Pricing] }) }
 */
export function pageSchema<const B extends ReadonlyArray<BlockDefinition<any, any>> = []>(options: { blocks?: B } = {}) {
  return v.object({
    title: v.text({ min: 1, max: 120 }),
    path: v.text({ format: "path", indexed: true, unique: true, label: "Path", description: "Where the page lives, like /about or /services/design" }),
    description: v.optional(v.text({ max: 160, multiline: true, label: "Search description", description: "Shown by search engines and link previews" })),
    blocks: blocks([...builtInBlocks, ...(options.blocks ?? ([] as unknown as B))])
  });
}
