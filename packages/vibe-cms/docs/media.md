# Media

Image, video and file fields: what they store, the rules they check, what queries return, and how to upload files from code.

Uploads go to the R2 bucket passed as `storage` in `createHandler` bindings, into one media library shared by the whole site. A media field stores a reference to a library file plus per-usage data (alt text, a focal point), never a URL.

```ts
// examples/schemas/src/media.ts
    product: v.object({
      name: v.text({ min: 1 }),
      // Stores `{ asset, alt, focal? }`; queries add `url`, `width`, `height`, `mime`, …
      photo: image({ minWidth: 800, aspectRatio: 4 / 3, folder: "products" }),
      gallery: v.array(image({ alt: "optional" }), { max: 12 }),
      demo: v.optional(video({ maxSize: "200MB", maxDuration: 120 })),
      manual: v.optional(file({ accept: ["application/pdf"], maxSize: "20MB" })),
      // The primitive the presets are built on: any file type, with your own per-usage fields.
      download: v.optional(v.asset({
        accept: ["application/zip"],
        maxSize: "50MB",
        fields: { version: v.text(), notes: v.optional(v.text({ multiline: true })) }
      }))
    })
```

`image`, `video` and `file` come from `vibe-cms/media`; `v.asset` from `vibe-cms/schema`.

| Field | Stores | Options |
|---|---|---|
| `image()` | `{ asset, alt, focal?: { x, y } }` | `accept` (default `image/*`), `maxSize`, `folder`, `minWidth`, `minHeight`, `aspectRatio` (width / height, 1% tolerance), `alt: "optional"` (alt text is required by default) |
| `video()` | `{ asset, poster? }` (poster is an image) | `accept` (default mp4, webm), `maxSize` (default 500MB), `folder`, `maxDuration` (seconds; needs a `media.analyze` plugin reporting `duration`) |
| `file()` | `{ asset, title? }` | `accept`, `maxSize`, `folder` |
| `v.asset()` | `{ asset, …fields }` | `accept` (MIME types, wildcards allowed), `maxSize` (`"5MB"`, `"1.5GiB"` or bytes), `folder`, `fields`, `validate(meta)` (return `true` or an error message) |

- `folder` is only the media library folder new uploads go to. It's never part of the file's URL or storage key.
- The rules are checked on upload (when the upload names the field) and again on every document write: a document referencing a file that's too small, the wrong type, or missing gets an issue on that field.
- Image dimensions are read from the file on upload (PNG, GIF, JPEG, WebP). Other metadata comes from `media.analyze` plugins: `vibe-cms docs server-hooks`.
- Deleting a document never deletes its files. Files used by documents can't be deleted from the library.

## What queries return

Queries merge the library record into each media value:

```ts
const product = await cms.query(config.schemas.product).findFirst();
product.photo
// { asset: "ast_…", alt: "Red chair", focal: { x: 0.4, y: 0.6 },
//   url: "/_vibe/media/ast_….jpg", mime: "image/jpeg", size: 183020, filename: "chair.jpg",
//   width: 1600, height: 1200, meta: { width: 1600, height: 1200 } }
```

`url` is root-relative and served by the CMS with immutable caching (edits to text files add `?v=<n>`). Use `width`, `height` and `focal` for layout:

```astro
<img src={product.photo.url} alt={product.photo.alt} width={product.photo.width} height={product.photo.height}
  style={product.photo.focal && `object-position: ${product.photo.focal.x * 100}% ${product.photo.focal.y * 100}%`} />
```

`InferOutput<typeof product>` is this resolved shape; `Infer` is the stored one (`vibe-cms docs schemas`).

## Uploading from code

Upload the file, then store its ID in the document:

```bash
bunx vibe-cms assets upload --file ./chair.jpg --folder products --type product --field photo --site http://localhost:1337
# → { "id": "ast_…", "url": "/_vibe/media/ast_….jpg", … }
bunx vibe-cms documents update --type product --id doc_… --data '{"name":"Chair","photo":{"asset":"ast_…","alt":"Red chair"},"gallery":[]}' --site http://localhost:1337
```

`--type` and `--field` check the file against that field's rules before it's stored. The same actions are `POST /_vibe/api/actions/assets.upload` (multipart, field `file`) and the `assets_upload` MCP tool (file as `{ name, type?, base64 }`). See `vibe-cms docs cli` and `vibe-cms docs agents`.
