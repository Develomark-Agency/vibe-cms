/**
 * What Blocks.astro and Variant.astro use at runtime. The `.astro` files ship as source, and they import this
 * through the package's own name (`vibe-cms/blocks/astro-runtime`) rather than by relative path, so a site gets
 * the same compiled copy that its own `vibe-cms/blocks` imports load. A relative import would load a second
 * copy from src, and `html`/`raw()` values from one copy would fail the other's `instanceof SafeHtml` check.
 *
 * Internal: not part of the documented API.
 */
export { renderBlock } from "./html.ts";
export { inPickRender, inPreview, pickSource, pickVariants } from "./preview.ts";
