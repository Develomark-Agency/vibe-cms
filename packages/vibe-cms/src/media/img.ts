/**
 * Attributes for an `<img>`, from an image field's query result. Framework-neutral: spread them in
 * Astro, React, Vue, Svelte, or turn them into HTML. Names that differ between React and HTML use
 * React's spelling (`srcSet`, `fetchPriority`); HTML attribute names ignore case, so they work everywhere.
 */
import { currentBreakpoints, IMAGE_WIDTHS, type Breakpoints } from "./widths.ts";

/** What `img()` reads from an image: an image field's query result, or an asset. */
export interface ImageLike {
  url: string,
  mime?: string,
  width?: number,
  height?: number,
  alt?: string | null,
  focal?: { x: number, y: number } | null
}

/** A width: pixels as a number, or any CSS length (`"50vw"`, `"calc(50vw - 2rem)"`). */
type Length = number | string;

/**
 * How wide the image is laid out.
 * - A number: as wide as the screen, up to that many pixels (`768` → `(min-width: 768px) 768px, 100vw`).
 * - An object: the width from each breakpoint up, `base` below them all (`{ base: "100vw", md: "50vw", xl: 640 }`).
 * - A string: a `sizes` attribute as it is.
 */
export type Sizes = number | string | ({ base?: Length } & Record<string, Length>);

export interface ImgOptions {
  /** How wide the image is laid out. Defaults to the full screen width. */
  sizes?: Sizes,
  /** The main image above the fold: loads first instead of lazily. */
  priority?: boolean,
  /** Overrides the stored alt text. */
  alt?: string,
  /** `field(entry, "cover")`, for click-to-edit in draft previews. */
  field?: string,
  /** 30–100, default 80. */
  quality?: number,
  /** Breakpoint names for `sizes`. Defaults to the config's `media.breakpoints`, else Tailwind's. */
  breakpoints?: Breakpoints
}

export interface ImgAttributes {
  src: string,
  srcSet?: string,
  sizes?: string,
  width?: number,
  height?: number,
  alt: string,
  loading: "lazy" | "eager",
  decoding: "async" | "auto",
  fetchPriority?: "high",
  "data-vibe-field"?: string
}

/** Media types the CMS resizes; SVGs and GIFs are served as they are. */
const RESIZABLE = /^image\/(jpeg|png|webp|avif)$/;

/** Below this, a width is narrower than any screen, so `sizes` is just that width. */
const NARROWEST_SCREEN = 320;

/** Screens this dense and denser get images twice the laid-out width. */
const MAX_DENSITY = 2;

function isResizable(image: ImageLike): boolean {
  return !image.mime || RESIZABLE.test(image.mime);
}

/** An image's URL at a width (rounded up by the server to one of `IMAGE_WIDTHS`). Other files' URLs come back as they are. */
export function imageUrl(image: ImageLike, width: number, options: { quality?: number } = {}): string {
  if(!isResizable(image)) return image.url;
  const [path, query = ""] = image.url.split("?");
  const params = new URLSearchParams(query);
  params.set("w", String(width));
  if(options.quality) params.set("q", String(options.quality));
  return `${path}?${params}`;
}

function length(value: Length): string {
  return typeof value === "number" ? `${value}px` : value;
}

/** `sizes` as the HTML attribute, plus the widest the image is ever laid out when that's known in pixels. */
export function sizesAttribute(sizes: Sizes | undefined, breakpoints: Breakpoints = currentBreakpoints()): { attribute: string, max?: number } {
  if(sizes === undefined) return { attribute: "100vw" };
  if(typeof sizes === "string") return { attribute: sizes };
  if(typeof sizes === "number") {
    return sizes <= NARROWEST_SCREEN ? { attribute: `${sizes}px`, max: sizes } : { attribute: `(min-width: ${sizes}px) ${sizes}px, 100vw`, max: sizes };
  }
  const steps = Object.entries(sizes).filter(([key]) => key !== "base").map(([key, value]) => {
    const at = breakpoints[key];
    if(at === undefined) throw new Error(`vibe-cms: img() sizes uses an unknown breakpoint "${key}" (known: ${Object.keys(breakpoints).join(", ")})`);
    return { at, value };
  }).sort((a, b) => b.at - a.at);
  const base = sizes.base ?? "100vw";
  const attribute = [...steps.map(s => `(min-width: ${s.at}px) ${length(s.value)}`), length(base)].join(", ");
  const values = [base, ...steps.map(s => s.value)];
  const max = values.every(v => typeof v === "number") ? Math.max(...(values as number[])) : undefined;
  return { attribute, max };
}

/**
 * Everything an `<img>` needs: a resized `src`, a `srcSet` across `IMAGE_WIDTHS`, `sizes`, the
 * dimensions that keep the layout from shifting, alt text, and lazy loading.
 *
 * ```astro
 * <img {...img(entry.cover, { sizes: { base: "100vw", md: 768 } })} />
 * ```
 *
 * The focal point needs `style`, which React and HTML spell differently: use `focus()`.
 */
export function img(image: ImageLike, options: ImgOptions = {}): ImgAttributes {
  const attrs: ImgAttributes = {
    src: image.url,
    alt: options.alt ?? image.alt ?? "",
    loading: options.priority ? "eager" : "lazy",
    decoding: options.priority ? "auto" : "async"
  };
  if(options.priority) attrs.fetchPriority = "high";
  if(image.width) attrs.width = image.width;
  if(image.height) attrs.height = image.height;
  if(isResizable(image)) {
    const { attribute, max } = sizesAttribute(options.sizes, options.breakpoints);
    const largest = IMAGE_WIDTHS.at(-1)!;
    // Widths below the original, then the original itself when it's smaller than the largest.
    let widths: number[] = IMAGE_WIDTHS.filter(w => !image.width || w < image.width);
    if(image.width && image.width <= largest) widths.push(image.width);
    // Never more than a dense screen needs: up to the first width that covers it.
    if(max) {
      const needed = max * MAX_DENSITY;
      const cover = widths.findIndex(w => w >= needed);
      if(cover !== -1) widths = widths.slice(0, cover + 1);
    }
    if(widths.length) {
      const quality = options.quality ? { quality: options.quality } : {};
      attrs.srcSet = widths.map(w => `${imageUrl(image, w, quality)} ${w}w`).join(", ");
      attrs.sizes = attribute;
      // For browsers without srcset: the width that covers the laid-out size, else a typical desktop one.
      const fallback = widths.find(w => w >= (max ?? 1280)) ?? widths.at(-1)!;
      attrs.src = imageUrl(image, fallback, quality);
    }
  }
  if(options.field !== undefined) attrs["data-vibe-field"] = options.field;
  return attrs;
}

/** The focal point as an `object-position` value: `"30% 60%"`, or the center when there's none. */
export function focus(image: Pick<ImageLike, "focal">): string {
  const focal = image.focal;
  return focal ? `${round(focal.x * 100)}% ${round(focal.y * 100)}%` : "50% 50%";
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

const HTML_NAMES: Record<string, string> = { srcSet: "srcset", fetchPriority: "fetchpriority" };

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** `img()`'s attributes as an HTML `<img>` tag, for the HTML renderers. `extra` is appended as it is (already escaped). */
export function imgTag(attrs: ImgAttributes, extra = ""): string {
  const parts = Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${HTML_NAMES[name] ?? name}="${escapeAttribute(String(value))}"`);
  return `<img ${parts.join(" ")}${extra}>`;
}
