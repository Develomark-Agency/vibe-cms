# Media

Image, video and file fields: what they store, the rules they check, what queries return, and how to upload files from code.

Media fields are how images, video and documents become content: an editor can replace a hero image, crop around a focal point, fix alt text or swap a brochure PDF, and every page using the file updates. Files that are part of the design rather than the content (the logo in the layout, icons, background textures) can stay in the site's own assets. Everything editors may want to change goes through the media library, which also gives files sizes, dimensions and immutable caching for free.

Uploads go to the R2 bucket passed as `storage` in `createHandler` bindings, into one media library shared by the whole site. A media field stores a reference to a library file plus per-usage data (alt text, a focal point), never a URL.

```ts
// examples/schemas/src/media.ts
    product: {
      schema: v.object({
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
    }
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
<img {...img(product.photo, { sizes: 768 })} style={`object-position: ${focus(product.photo)}`} />
```

`img()` is covered under [Optimized images](#optimized-images).

`InferOutput<typeof product>` is this resolved shape; `Infer` is the stored one (`vibe-cms docs schemas`).

## Optimized images

With Cloudflare's Images binding, image URLs take a width: `/_vibe/media/ast_….jpg?w=800` is resized and sent as AVIF or WebP, whichever the browser accepts. Originals in R2 are never changed.

`img()` from `vibe-cms/media` returns everything an `<img>` needs — `src`, `srcSet`, `sizes`, `width`, `height`, `alt`, lazy loading — as one object to spread. It works the same in Astro, React, Vue, Svelte and plain HTML: names that differ use React's spelling (`srcSet`), and HTML attribute names ignore case.

```astro
---
import { focus, img } from "vibe-cms/media";
---
<img {...img(entry.cover, { sizes: 768, priority: true, field: field(entry, "cover") })}
  style={`object-position: ${focus(entry.cover)}`} />
```

`style` isn't included because React wants an object and the rest a string: `focus()` gives the focal point as an `object-position` value (`"30% 60%"`), for `style={{ objectPosition: focus(photo) }}` in React.

`sizes` says how wide the image is laid out, so the browser picks the right file:

| `sizes` | Means | Attribute |
|---|---|---|
| (none) | full screen width | `100vw` |
| `768` | full width, up to 768px | `(min-width: 768px) 768px, 100vw` |
| `48` | always 48px (narrower than any screen) | `48px` |
| `{ base: "100vw", md: "50vw", xl: 640 }` | per breakpoint, from that width up | `(min-width: 1280px) 640px, (min-width: 768px) 50vw, 100vw` |
| a string | used as it is | |

Numbers are pixels; strings are any CSS length. Breakpoint names default to Tailwind's (`sm` 640, `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536); set your own with `media: { breakpoints: { … } }` in the config, or pass `breakpoints` to `img()` where the config isn't imported. When the widest size is known in pixels, `srcSet` stops at what a 2× screen needs.

Other options: `priority` (the main image above the fold: loads eagerly, `fetchPriority="high"`), `alt` (overrides the stored text), `field` (adds `data-vibe-field` for click-to-edit in previews), `quality` (30–100, default 80). The blocks and rich-text renderers use `img()` themselves.

Widths are rounded up to one of `IMAGE_WIDTHS` (320, 640, 960, 1280, 1920, 2560) and never past the original. Cloudflare bills each distinct image and options once a month, after 5,000 free, so the fixed set keeps arbitrary widths from adding up. JPEG, PNG, WebP and AVIF are resized; SVG and GIF are served as they are.

Add the binding and hand it to the CMS:

```ts
// alchemy.run.ts
import { Images } from "alchemy/cloudflare";
const images = Images();
// … bindings: { DB: db, MEDIA: media, IMAGES: images }

// src/cms.ts
createHandler(config, { bindings: env => ({ db: env.DB, storage: env.MEDIA, images: env.IMAGES }) });
```

Under wrangler it's `"images": { "binding": "IMAGES" }`. Cloudflare may also need image transformations enabled for the account or zone (Images → Transformations in the dashboard).

If transforming fails, the CMS serves the original instead, so pages never break, with a 5-minute cache so a fix shows up soon. It then transforms a tiny test image to tell a broken setup from a single bad file, and records the result. It also checks every few hours, from cron and when the editor loads. While optimization is failing, the editor shows a warning to people who can manage the site, and the agency panel marks the site's card. The site's `/.well-known/vibe-cms` lists the warnings under `warnings`.

A site with media but no binding gets the same warning. To serve originals on purpose and silence it, pass `images: false`.

## Location and camera details

Photos from phones often carry their GPS coordinates and camera details (EXIF, XMP), which anyone who downloads the file can read. Uploads remove them by default, at the byte level: the image itself isn't re-encoded, and orientation is kept so photos don't turn sideways. The file's details then show `metadataRemoved: true` in its `meta`.

In the editor, picking or dropping a photo that has these details asks first, with a switch to keep them. Files without any (most screenshots and images saved from the web) upload without a prompt. The editor's Site page has the site-wide setting: turning it off makes keeping them the suggested answer, and the default for uploads from the CLI and agents (`site_update` with `stripMetadata: false`), which can also pass `stripMetadata` per upload. Removing them can't be undone after upload. Uploading folders always asks first, listing what's in them; videos and other formats are listed as not checked.

Details kept at upload can be removed later: the media library's preview pane shows a photo's metadata, with **Remove details**. From code it's `assets_stripMetadata` (or `DELETE /_vibe/api/assets/<id>/metadata`). The file keeps its ID and gets a new `?v=` URL; copies already cached at the old URL (in browsers or CDNs) stay until they expire.

## Uploading from code

Upload the file, then store its ID in the document:

```bash
bunx vibe-cms assets upload --file ./chair.jpg --folder products --type product --field photo --site http://localhost:1337
# → { "id": "ast_…", "url": "/_vibe/media/ast_….jpg", … }
bunx vibe-cms documents update --type product --id doc_… --data '{"name":"Chair","photo":{"asset":"ast_…","alt":"Red chair"},"gallery":[]}' --site http://localhost:1337
```

`--type` and `--field` check the file against that field's rules before it's stored. The same actions are `POST /_vibe/api/actions/assets.upload` (multipart, field `file`) and the `assets_upload` MCP tool (file as `{ name, type?, base64 }`). See `vibe-cms docs cli` and `vibe-cms docs agents`.
