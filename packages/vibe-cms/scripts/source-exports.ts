/**
 * Exports published as TypeScript source instead of compiled to dist. `vibe-cms/blocks/astro` re-exports
 * `.astro` components, which only Astro's compiler can build, so it ships as written and the site's Astro
 * build compiles it (Astro processes packages that list `astro` as a peer dependency).
 */
export const SOURCE_EXPORTS = new Set(["./blocks/astro"]);
