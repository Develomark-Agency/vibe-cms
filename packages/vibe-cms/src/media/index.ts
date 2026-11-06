import { defineWidget } from "../descriptor.ts";
export { IMAGE_WIDTHS, DEFAULT_BREAKPOINTS, type Breakpoints } from "./widths.ts";
export { img, focus, imageUrl, sizesAttribute, type ImgOptions, type ImgAttributes, type Sizes, type ImageLike } from "./img.ts";
import * as v from "../schema/builders.ts";
import type { AssetMeta, AssetSchema, ObjectSchema, OptionalSchema, TextSchema, NumberSchema } from "../schema/types.ts";

/** Options for the editor's file picker widget. */
export interface AssetPickerOptions {
  /** Show the focal point picker (images). */
  focal?: boolean,
  /** Aspect ratio hint for the preview. */
  aspectRatio?: number
}

/** Upload, pick from the library, preview, and edit per-usage fields. */
export const AssetPicker = defineWidget<any, AssetPickerOptions>({
  id: "vibe-cms:asset-picker",
  admin: () => import("../admin/widgets/asset-picker.admin.tsx")
});

export interface ImageOptions {
  /** MIME types. Defaults to `image/*`. */
  accept?: string[],
  /** e.g. `"5MB"`, or bytes. */
  maxSize?: string | number,
  /** Media library folder for new uploads. Never part of the file's URL. */
  folder?: string,
  /** Pixels. */
  minWidth?: number,
  /** Pixels. */
  minHeight?: number,
  /** Width / height, e.g. `16 / 9`. Allowed off by 1%. */
  aspectRatio?: number,
  /** Alt text is required unless set to `"optional"`. */
  alt?: "required" | "optional"
}

/** An image field's dimension rules against a file's metadata: `true`, or the reason it fails. */
export function checkImage(meta: AssetMeta, opts: ImageOptions): true | string {
  const { width, height } = meta;
  if(width === undefined || height === undefined) {
    return opts.minWidth || opts.minHeight || opts.aspectRatio ? "Couldn't read this image's dimensions" : true;
  }
  if(opts.minWidth && width < opts.minWidth) return `Must be at least ${opts.minWidth}px wide (this one is ${width}px)`;
  if(opts.minHeight && height < opts.minHeight) return `Must be at least ${opts.minHeight}px tall (this one is ${height}px)`;
  if(opts.aspectRatio && Math.abs(width / height - opts.aspectRatio) / opts.aspectRatio > 0.01) {
    return `Must have a ${formatRatio(opts.aspectRatio)} aspect ratio`;
  }
  return true;
}

function formatRatio(ratio: number): string {
  for(const [w, h] of [[16, 9], [4, 3], [3, 2], [1, 1], [21, 9], [9, 16], [3, 4], [2, 3], [4, 5]] as const) {
    if(Math.abs(ratio - w / h) < 0.001) return `${w}:${h}`;
  }
  return ratio.toFixed(2);
}

type ImageFields<O extends ImageOptions> = {
  alt: O["alt"] extends "optional" ? OptionalSchema<TextSchema> : TextSchema,
  focal: OptionalSchema<ObjectSchema<{ x: NumberSchema, y: NumberSchema }>>
};

/**
 * An image field: stores `{ asset, alt, focal? }`; queries add `url`, `width`, `height` and the
 * rest. Rules are checked on upload and on every write. See `vibe-cms docs media`.
 */
export function image<const O extends ImageOptions = {}>(opts: O = {} as O): AssetSchema<ImageFields<O>> {
  const alt = v.text({ label: "Alt text", description: "Describes the image for screen readers and search engines" });
  return v.asset({
    accept: opts.accept ?? ["image/*"],
    maxSize: opts.maxSize,
    folder: opts.folder,
    validate: meta => checkImage(meta, opts),
    fields: {
      alt: (opts.alt === "optional" ? v.optional(alt) : alt) as ImageFields<O>["alt"],
      focal: v.optional(v.object({ x: v.number({ min: 0, max: 1 }), y: v.number({ min: 0, max: 1 }) }))
    },
    widget: AssetPicker({ focal: true, aspectRatio: opts.aspectRatio })
  });
}

export interface VideoOptions {
  /** MIME types. Defaults to mp4 and webm. */
  accept?: string[],
  /** Defaults to `"500MB"`. */
  maxSize?: string | number,
  /** Media library folder for new uploads. */
  folder?: string,
  /** Seconds. Needs a `media.analyze` plugin that reports `duration`. */
  maxDuration?: number
}

/** A video field's duration rule against a file's metadata. */
export function checkVideo(meta: AssetMeta, opts: VideoOptions): true | string {
  if(opts.maxDuration && meta.duration !== undefined && meta.duration > opts.maxDuration) {
    return `Must be at most ${opts.maxDuration} seconds long`;
  }
  return true;
}

/** A video field: stores `{ asset, poster? }`, the poster being an optional image. */
export function video(opts: VideoOptions = {}) {
  return v.asset({
    accept: opts.accept ?? ["video/mp4", "video/webm"],
    maxSize: opts.maxSize ?? "500MB",
    folder: opts.folder,
    validate: meta => checkVideo(meta, opts),
    fields: { poster: v.optional(image({ alt: "optional" })) },
    widget: AssetPicker()
  });
}

/** Any file, e.g. PDFs. */
export function file(opts: { accept?: string[], maxSize?: string | number, folder?: string } = {}) {
  return v.asset({
    accept: opts.accept,
    maxSize: opts.maxSize,
    folder: opts.folder,
    fields: { title: v.optional(v.text({ label: "Title" })) },
    widget: AssetPicker()
  });
}
