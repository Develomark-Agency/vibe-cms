import type { AnyBlock } from "./define.ts";
import type { BuiltInType } from "./builtins.ts";

/** An Astro component, or a React, Vue or Svelte one: anything Astro can render. */
// Astro's component types are loose, so this is too; each component checks its own props.
export type AstroComponent = (props: any) => unknown;

/** Required for every custom block type in the page's schema, optional for built-ins. */
export type AstroComponents<B extends AnyBlock> =
  & { [T in Exclude<B["type"], BuiltInType>]: AstroComponent }
  & { [T in Extract<B["type"], BuiltInType>]?: AstroComponent };

export { default as Blocks } from "./Blocks.astro";
