/**
 * The widths optimized images come in. A `?w=` request is rounded up to one of these: Cloudflare
 * bills each distinct source and options once a month, so a fixed set keeps arbitrary widths from
 * adding up.
 */
export const IMAGE_WIDTHS = [320, 640, 960, 1280, 1920, 2560] as const;

/** Named viewport widths in pixels, for `img()`'s `sizes`. */
export type Breakpoints = Record<string, number>;

/** Tailwind's, so the names match the classes most sites already use. */
export const DEFAULT_BREAKPOINTS: Breakpoints = { sm: 640, md: 768, lg: 1024, xl: 1280, "2xl": 1536 };

let breakpoints: Breakpoints = DEFAULT_BREAKPOINTS;

/** `defineConfig` sets the site's `media.breakpoints`, so `img()` sees them wherever the config is imported. */
export function setBreakpoints(next: Breakpoints | undefined): void {
  breakpoints = next ?? DEFAULT_BREAKPOINTS;
}

export function currentBreakpoints(): Breakpoints {
  return breakpoints;
}
