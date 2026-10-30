# Config and schemas

## `vibe-cms.config.ts`

The config is TypeScript, but what it *produces* is a serializable tree of plain data plus tagged descriptors. Every widget, plugin and field preset in the tree is a descriptor object with a `kind` tag.

```ts
import { defineConfig } from "vibe-cms";
import v from "vibe-cms/schema";
import { RichEditor } from "./widgets/rich-editor";
import { ExamplePlugin } from "./plugins/example-plugin";

export default defineConfig({
  plugins: [ExamplePlugin()],
  locales: ["en", "fr"],
  schemas: {
    post: v.object({
      title: v.text(),
      subtitle: v.optional(v.text()),
      body: v.text({ widget: RichEditor() }),
    }),
  },
});
```

What a descriptor looks like once evaluated:

```ts
RichEditor({ toolbar: "minimal" });
// → {
//     kind: "widget",
//     id: "@acme/rich-text:editor",
//     options: { toolbar: "minimal" },
//     [IMPL]: { admin: () => import("./rich-editor.admin") },
//   }
```

### Registration is implicit

There is no `register(RichEditor)`. The config tree is walked recursively, and everything tagged with a `kind` (widgets, plugins, presets, field types) is registered as it is found. Using a widget in a schema is enough.

IDs are namespaced by package (`@acme/rich-text:editor`) to avoid collisions.

### Why serializable

- The Worker and the admin app consume the same config without either one loading the other's code.
- The schema can be sent to the admin app as data.
- Schemas can be diffed between deploys.

Keeping admin code out of the Worker bundle (and server code out of the admin bundle) is handled by the build, see [build.md](./build.md).

## The `v` schema builder

A Zod-like builder made of generic primitives.

```ts
import v from "vibe-cms/schema";

const author = v.object({
  name: v.text(),
  email: v.text({ format: "email" }),
  avatar: image(), // vibe-cms/media preset over v.asset(), see below
});

const post = v.object({
  title: v.text({ min: 1, max: 120 }),
  slug: v.text({ indexed: true }),            // filterable, see query-api.md
  publishedAt: v.date(),
  tags: v.array(v.text()),
  author: v.ref("author"),                     // reference to another content type
  seo: v.optional(v.object({
    description: v.text({ max: 160 }),
  })),
  layout: v.enum(["default", "wide"]),
  body: v.array(v.union([paragraph, heading, image])),
});
```

Content types are inferred:

```ts
type Post = v.Infer<typeof config.schemas.post>;
```

`v.ref()` and `v.asset()` are core because the engine needs to see references for integrity checks and for `with:` expansion in queries.

## Field presets instead of special schema types

There is no `v.richText()` in core. "Rich text" is a data shape, so it is expressed with primitives, and a package ships it as a **preset**: the schema plus a default widget.

```ts
// @acme/rich-text
import v from "vibe-cms/schema";
import { RichEditor } from "./editor";

const text = v.object({ kind: v.literal("text"), text: v.text(), marks: v.array(mark) });
const paragraph = v.object({ kind: v.literal("p"), children: v.array(inline) });
const heading = v.object({ kind: v.literal("h"), level: v.number(), children: v.array(inline) });
const image = v.object({ kind: v.literal("image"), asset: v.asset({ accept: ["image/*"] }) });
const link = v.object({ kind: v.literal("link"), to: v.ref(), children: v.array(text) });

export type RichTextDoc = v.Infer<ReturnType<typeof richText>>;

export const richText = (opts?: RichEditorOptions) =>
  v.array(v.union([paragraph, heading, image]), {
    widget: RichEditor(opts),
  });
```

Used in a config:

```ts
schemas: {
  post: v.object({
    title: v.text(),
    body: richText({ toolbar: "minimal" }),
  }),
}
```

This keeps:
- **Validation on the server.** API writes that bypass the widget are still checked against the real shape.
- **Types for consumers.** The Astro site gets `RichTextDoc`, not `unknown`.
- **References visible to the engine.** A link inside rich text is a `v.ref()`, so it participates in integrity checks and `with:` expansion.
- **Schema and widget decoupled.** The pairing is a default, not a requirement. The same widget can be used anywhere its value type fits.

## Assets and media presets

A type is core only if the engine must do work for it beyond validating JSON. `v.ref()` and `v.asset()` meet that bar: assets need an upload pipeline, R2 storage, metadata extraction, usage tracking and URLs. Everything else is a preset.

### `v.asset()`

```ts
v.asset({
  accept: ["image/*"],                 // MIME types
  maxSize: "5MB",
  folder: "posts/covers",              // media library organization, not the R2 key
  validate: (meta) =>                  // server-side, against extracted metadata
    meta.width >= 1200 || "Must be at least 1200px wide",
  fields: {                            // per-usage data stored in the document
    alt: v.text(),
  },
  widget: AssetPicker(),
})
```

- **`folder`** is where uploads land by default and what the picker shows first. R2 keys are always derived from the asset ID, so reorganizing folders never breaks stored files.
- **`validate`** runs in the Worker at upload time (the upload request names its target field) and again on document write (in case a write points at an asset uploaded for another field). Metadata comes from the `media.analyze` hook, see [plugins.md](./plugins.md).
- **`fields`** holds data about *this use* of the asset, like alt text or a focal point, since the same file can need different alt text in different places.
- Assets live in one shared media library. The default widget offers upload or picking an existing asset. Deleting a document never deletes assets; unreferenced assets are cleaned up separately. Deleted documents and files go to the trash first (see storage.md).

### `image()` and `video()`

Shipped with vibe-cms from `vibe-cms/media`, but they are ordinary presets over `v.asset()`. A plugin could ship `audio()` the same way.

```ts
// vibe-cms/media
export const image = (opts: ImageOptions = {}) =>
  v.asset({
    accept: opts.accept ?? ["image/*"],
    maxSize: opts.maxSize,
    folder: opts.folder,
    validate: (meta) => checkImage(meta, opts), // minWidth, aspectRatio, …
    fields: {
      alt: opts.alt === "optional" ? v.optional(v.text()) : v.text(),
      focal: v.optional(v.object({ x: v.number(), y: v.number() })),
    },
    widget: ImagePicker(opts), // upload + library picker + preview + alt + focal point
  });

export const video = (opts: VideoOptions = {}) =>
  v.asset({
    accept: opts.accept ?? ["video/mp4", "video/webm"],
    maxSize: opts.maxSize ?? "500MB",
    folder: opts.folder,
    validate: (meta) => checkVideo(meta, opts), // maxDuration, …
    fields: { poster: v.optional(image()) },
    widget: VideoPicker(opts),
  });
```

```ts
import { image, video } from "vibe-cms/media";

post: v.object({
  cover: image({ minWidth: 1200, aspectRatio: 16 / 9, folder: "posts/covers" }),
  trailer: v.optional(video({ maxDuration: 90 })),
})
```

What consumers get back from a query, with the asset's record merged into the per-usage fields:

```ts
post.cover;
// {
//   url: "https://my-client-site.com/_vibe/media/ast_8f2….webp",
//   mime: "image/webp", size: 182331, width: 2400, height: 1350,
//   alt: "Sunset over the bay", focal: { x: 0.4, y: 0.6 },
// }
```

## Widgets are typed against field values

A widget declares the value type it edits, and the field it is attached to must match.

```ts
v.text({ widget: RichEditor() });
// ✗ Type error: RichEditor edits RichTextDoc, field value is string

v.array(v.union([paragraph, heading, image]), { widget: RichEditor() });
// ✓
```
