# Rich text

The `richText()` field from `vibe-cms/rich-text`: what it stores, its editor options, and rendering it to HTML or plain text.

```ts
// examples/schemas/src/presets.ts
    post: v.object({
      title: v.text(),
      // Rich text is an array of blocks and inline nodes, edited with a Tiptap widget.
      body: richText(),
      teaser: v.optional(richText({ toolbar: "minimal" })),
```

`richText(options)` is an ordinary `v.array` of block nodes with a Tiptap editor as its widget, so drafts, validation, versions, translations and queries need nothing special.

| Option | What |
|---|---|
| `toolbar` | `"full"` (default): marks, links, headings, lists, quotes and images. `"minimal"`: marks and links only. |
| `placeholder` | Shown in an empty editor |
| `label`, `description` | As on any field |

## What's stored

```json
[
  { "kind": "h", "level": 2, "children": [{ "kind": "text", "text": "Hello" }] },
  { "kind": "p", "children": [
    { "kind": "text", "text": "Read the ", "marks": ["bold"] },
    { "kind": "link", "to": { "type": "post", "id": "doc_…" }, "children": [{ "kind": "text", "text": "launch post" }] }
  ] },
  { "kind": "list", "ordered": false, "items": [[{ "kind": "text", "text": "One" }]] },
  { "kind": "image", "asset": { "asset": "ast_…", "alt": "Diagram" } }
]
```

Blocks are `p`, `h` (levels 2-4), `quote`, `list` and `image`; inline nodes are `text` (marks: `bold`, `italic`, `underline`, `strike`, `code`) and `link` (an `href`, or `to` a document). The schema pieces (`block`, `inline`, …) and types (`RichTextDoc`, `RichTextOutput`) are exported for building your own variants.

## Rendering

```ts
import { renderRichText, toPlainText } from "vibe-cms/rich-text";

const html = renderRichText(post.body, { linkTo: ref => `/${ref.type}s/${ref.id}` });
const words = toPlainText(post.body).split(/\s+/).length;
```

- `renderRichText` escapes text, only keeps `http(s)`, `mailto`, `tel`, relative and `#` links, and renders images from the query's resolved asset URL. `linkTo` turns document links into URLs (default `#type-id`).
- `toPlainText` is for excerpts, search and word counts; it works in plugins on stored drafts too.
- `vibe-cms/rich-text/render` exports just the renderers, without the editor widget's descriptor.

Inject the HTML with your framework's raw-HTML mechanism (Astro's `set:html`, React's `dangerouslySetInnerHTML`).
