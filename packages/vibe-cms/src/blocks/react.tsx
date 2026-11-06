import type { ComponentType, ReactNode } from "react";
import type { AnyBlock } from "./define.ts";
import type { BuiltInType } from "./builtins.ts";
import { renderBlock, type RenderContext } from "./html.ts";

/**
 * React components per block type: required for every custom type in the
 * page's schema (leaving one out is a type error), optional for built-ins,
 * which otherwise render as the shared HTML. Each component receives the
 * block's data as props, so it can be a client component with state and
 * handlers ("use client") or a server component.
 */
export type ReactComponents<B extends AnyBlock> =
  & { [T in Exclude<B["type"], BuiltInType>]: ComponentType<Extract<B, { type: T }>> }
  & { [T in Extract<B["type"], BuiltInType>]?: ComponentType<Extract<B, { type: T }>> };

export interface BlocksProps<B extends AnyBlock> extends RenderContext {
  blocks: readonly B[] | null | undefined,
  components: ReactComponents<B>
}

export interface BlockProps<B extends AnyBlock> extends RenderContext {
  block: B,
  components: ReactComponents<B>
}

/** One block: your component for its type, or the built-in markup. */
export function Block<B extends AnyBlock>({ block, components, linkTo }: BlockProps<B>): ReactNode {
  const Component = (components as Record<string, ComponentType<B> | undefined>)[block.type];
  if(Component) return <Component {...block} />;
  // Built-in blocks are static markup; `display: contents` keeps the wrapper out of the layout.
  return <div data-vibe-block={block.type} style={{ display: "contents" }} dangerouslySetInnerHTML={{ __html: renderBlock(block, { linkTo }) }} />;
}

/**
 * A page's blocks, in the order editors arranged them. No hooks, so it works
 * as a React Server Component: only components marked "use client" hydrate.
 */
export function Blocks<B extends AnyBlock>({ blocks, components, linkTo }: BlocksProps<B>): ReactNode {
  // Blocks have no IDs; the list only changes when the page is republished, so positions are stable keys.
  return <>{(blocks ?? []).map((block, i) => <Block key={`${i}:${block.type}`} block={block} components={components} linkTo={linkTo} />)}</>;
}
