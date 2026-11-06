import { expect, test } from "bun:test";
import { validate } from "../../src/schema/index.ts";
import { fromTiptap, toTiptap } from "../../src/rich-text/editor.admin.tsx";
import { richText, renderRichText, toPlainText, type RichTextDoc } from "../../src/rich-text/index.ts";

const doc: RichTextDoc = [
  { kind: "h", level: 2, children: [{ kind: "text", text: "Hello" }] },
  {
    kind: "p",
    children: [
      { kind: "text", text: "Some " },
      { kind: "text", text: "bold", marks: ["bold"] },
      { kind: "text", text: " and a " },
      { kind: "link", href: "https://example.com", children: [{ kind: "text", text: "link" }] },
      { kind: "text", text: " to " },
      { kind: "link", to: { type: "post", id: "doc_1" }, children: [{ kind: "text", text: "a post" }] }
    ]
  },
  { kind: "list", ordered: false, items: [[{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]] },
  { kind: "quote", children: [{ kind: "text", text: "<quoted>" }] },
  { kind: "image", asset: { asset: "ast_1", alt: "A picture" } }
];

test("the preset validates its own shape", () => {
  expect(validate(richText(), doc).issues).toEqual([]);
  expect(validate(richText(), [{ kind: "h", level: 9, children: [] }]).issues[0]?.message).toBe("Must be at most 4");
});

test("round-trips through the editor's document model", () => {
  expect(fromTiptap(toTiptap(doc, id => `/_vibe/media/${id}`))).toEqual(doc);
  expect(fromTiptap(toTiptap([], () => ""))).toEqual([]);
});

test("renders escaped HTML and plain text", () => {
  const html = renderRichText(doc, { linkTo: ref => `/${ref.type}s/${ref.id}` });
  expect(html).toContain("<h2>Hello</h2>");
  expect(html).toContain("<strong>bold</strong>");
  expect(html).toContain("<a href=\"/posts/doc_1\">a post</a>");
  expect(html).toContain("&#60;quoted&#62;");
  expect(html).not.toContain("<img");
  expect(toPlainText(doc)).toContain("Some bold and a link to a post");
});
