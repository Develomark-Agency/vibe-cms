import v from "../schema/index.ts";

export const mark = v.enum(["bold", "italic", "underline", "strike", "code"]);

export const text = v.object({
  kind: v.literal("text"),
  text: v.text(),
  marks: v.optional(v.array(mark))
});

/** A link to another document (`to`, checked by the engine) or to a URL (`href`). */
export const link = v.object({
  kind: v.literal("link"),
  to: v.optional(v.ref()),
  href: v.optional(v.text()),
  children: v.array(text)
});

export const inline = v.union([text, link]);

export const paragraph = v.object({ kind: v.literal("p"), children: v.array(inline) });
export const heading = v.object({ kind: v.literal("h"), level: v.number({ integer: true, min: 2, max: 4 }), children: v.array(inline) });
export const quote = v.object({ kind: v.literal("quote"), children: v.array(inline) });
export const list = v.object({ kind: v.literal("list"), ordered: v.boolean(), items: v.array(v.array(inline)) });
export const image = v.object({
  kind: v.literal("image"),
  asset: v.asset({ accept: ["image/*"], fields: { alt: v.optional(v.text()) } })
});

export const block = v.union([paragraph, heading, quote, list, image]);

export type Mark = v.Infer<typeof mark>;
export type TextNode = v.Infer<typeof text>;
export type LinkNode = v.Infer<typeof link>;
export type InlineNode = v.Infer<typeof inline>;
export type Block = v.Infer<typeof block>;
export type RichTextDoc = Block[];
/** What queries return: image assets resolved to records with a URL. */
export type RichTextOutput = Array<v.InferOutput<typeof block>>;
