import { renderRichText, type RenderOptions } from "@vibe-cms/rich-text/render";
import { field } from "vibe-cms/preview";
import type { BlockProps, AnyBlock } from "./define.ts";
import { isBuiltInType, type BuiltInBlock, type BuiltInType } from "./builtins.ts";

/** Markup that's already safe: interpolating it into `html` leaves it as is. */
export class SafeHtml {
  constructor(readonly value: string) {}

  toString(): string {
    return this.value;
  }
}

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
}

/** Opts a string out of escaping. Only for markup you trust. */
export function raw(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

/** For `href` and `src`: keeps http(s), mailto, tel, site paths and anchors; anything else (like `javascript:`) becomes `#`. */
export function url(value: string | null | undefined): string {
  const trimmed = (value ?? "").trim();
  return /^(https?:|mailto:|tel:|\/|#|\?)/i.test(trimmed) ? trimmed : "#";
}

function interpolate(value: unknown): string {
  if(value instanceof SafeHtml) return value.value;
  if(value === null || value === undefined || value === false || value === true) return "";
  if(Array.isArray(value)) return value.map(interpolate).join("");
  return escape(String(value));
}

/**
 * Builds markup with every interpolated value escaped, so block content can't
 * inject HTML. Arrays are joined; `null`, `undefined` and booleans render
 * nothing, so `${cond && html`…`}` works. Use `url()` for links and sources.
 */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0]!;
  values.forEach((value, i) => {
    out += interpolate(value) + strings[i + 1]!;
  });
  return new SafeHtml(out);
}

export interface RenderContext {
  /** URLs for rich text links to other documents. */
  linkTo?: RenderOptions["linkTo"]
}

/** Renders one block's data as HTML. */
export type HtmlComponent<B> = (block: B, context: RenderContext) => SafeHtml | string;

type Of<T extends BuiltInType> = BlockProps<Extract<BuiltInBlock, { type: T }>>;

/** ` data-vibe-field="…"` for a `field()` mark, in a draft preview; nothing otherwise. */
function mark(value: string | undefined): SafeHtml {
  return raw(value === undefined ? "" : ` data-vibe-field="${escape(value)}"`);
}

function buttons(list: Of<"hero">["buttons"]): SafeHtml {
  if(list.length === 0) return html``;
  return html`<div class="vb-buttons">${field.entries(list).map(([b, attr]) => html`<a class="vb-button vb-button--${b.style}" href="${url(b.href)}"${mark(attr("label"))}>${b.label}</a>`)}</div>`;
}

function img(image: { url: string, alt?: string, width?: number, height?: number, focal?: { x: number, y: number } | null }, sizes?: string): SafeHtml {
  const position = image.focal ? ` style="object-position: ${image.focal.x * 100}% ${image.focal.y * 100}%"` : "";
  return html`<img src="${url(image.url)}" alt="${image.alt ?? ""}"${raw(image.width ? ` width="${image.width}"` : "")}${raw(image.height ? ` height="${image.height}"` : "")}${raw(sizes ? ` sizes="${escape(sizes)}"` : "")} loading="lazy" decoding="async"${raw(position)}${mark(field(image))}>`;
}

/** YouTube and Vimeo links become privacy-friendly embeds; anything else plays in a <video>. */
function embedUrl(link: string): string | null {
  const youtube = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/.exec(link);
  if(youtube) return `https://www.youtube-nocookie.com/embed/${youtube[1]}`;
  const vimeo = /vimeo\.com\/(?:video\/)?(\d+)/.exec(link);
  if(vimeo) return `https://player.vimeo.com/video/${vimeo[1]}?dnt=1`;
  return null;
}

/**
 * The built-in blocks as semantic, JavaScript-free HTML with `vb-` classes.
 * Every adapter uses these unless you pass your own component for the type;
 * `@vibe-cms/blocks/styles.css` gives them a neutral default look.
 */
export const builtInRenderers: { [T in BuiltInType]: HtmlComponent<Of<T>> } = {
  hero: b => html`<section class="vb-block vb-hero vb-hero--${b.align}">
  <div class="vb-hero__content">
    ${b.eyebrow && html`<p class="vb-eyebrow"${mark(field(b, "eyebrow"))}>${b.eyebrow}</p>`}
    <h1${mark(field(b, "heading"))}>${b.heading}</h1>
    ${b.text && html`<p class="vb-lead"${mark(field(b, "text"))}>${b.text}</p>`}
    ${buttons(b.buttons)}
  </div>
  ${b.image && html`<div class="vb-hero__media">${img(b.image, "(min-width: 60rem) 50vw, 100vw")}</div>`}
</section>`,
  text: (b, context) => html`<div class="vb-block vb-text"${mark(field(b, "body"))}>${raw(renderRichText(b.body, { linkTo: context.linkTo }))}</div>`,
  image: b => html`<figure class="vb-block vb-image vb-image--${b.width}">${img(b.image)}${b.caption && html`<figcaption${mark(field(b, "caption"))}>${b.caption}</figcaption>`}</figure>`,
  gallery: b => html`<div class="vb-block vb-gallery vb-gallery--${b.columns}">${b.images.map(image => html`<figure>${img(image, `(min-width: 60rem) ${Math.round(100 / Number(b.columns))}vw, 50vw`)}</figure>`)}</div>`,
  cta: b => html`<section class="vb-block vb-cta">
  <h2${mark(field(b, "heading"))}>${b.heading}</h2>
  ${b.text && html`<p${mark(field(b, "text"))}>${b.text}</p>`}
  ${buttons(b.buttons)}
</section>`,
  quote: b => html`<figure class="vb-block vb-quote">
  <blockquote${mark(field(b, "quote"))}><p>${b.quote}</p></blockquote>
  ${b.attribution && html`<figcaption${mark(field(b, "attribution"))}>${b.attribution}${b.role && html`<span${mark(field(b, "role"))}>, ${b.role}</span>`}</figcaption>`}
</figure>`,
  video: b => {
    const embed = embedUrl(b.url);
    const player = embed
      ? html`<div class="vb-video__frame"${mark(field(b, "url"))}><iframe src="${embed}" title="${b.caption ?? "Video"}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`
      : html`<video src="${url(b.url)}" controls preload="metadata"${mark(field(b, "url"))}></video>`;
    return html`<figure class="vb-block vb-video">${player}${b.caption && html`<figcaption${mark(field(b, "caption"))}>${b.caption}</figcaption>`}</figure>`;
  },
  // <details> opens and closes without any JavaScript.
  faq: b => html`<section class="vb-block vb-faq">
  ${b.heading && html`<h2${mark(field(b, "heading"))}>${b.heading}</h2>`}
  ${field.entries(b.items).map(([item, attr]) => html`<details${mark(attr())}><summary${mark(attr("question"))}>${item.question}</summary><p${mark(attr("answer"))}>${item.answer}</p></details>`)}
</section>`,
  divider: b => (b.style === "line" ? html`<hr class="vb-block vb-divider">` : html`<div class="vb-block vb-spacer" aria-hidden="true"></div>`)
};

export function renderBuiltIn(block: AnyBlock, context: RenderContext = {}): string {
  if(!isBuiltInType(block.type)) return "";
  const render = builtInRenderers[block.type] as HtmlComponent<AnyBlock>;
  return String(render(block, context));
}

/**
 * Components for custom block types, required for each one, and optional
 * replacements for built-ins. Leaving out a custom type is a type error.
 */
export type HtmlComponents<B extends AnyBlock> =
  & { [T in Exclude<B["type"], BuiltInType>]: HtmlComponent<Extract<B, { type: T }>> }
  & { [T in Extract<B["type"], BuiltInType>]?: HtmlComponent<Extract<B, { type: T }>> };

export interface HtmlOptions<B extends AnyBlock> extends RenderContext {
  components?: HtmlComponents<B>
}

function missing(type: string): string {
  // Visible in the page source, invisible on the page: a schema change shouldn't take a page down.
  return `<!-- vibe-cms: no component for block "${escape(type).replace(/--/g, "")}" -->`;
}

export function renderBlock<B extends AnyBlock>(block: B, options: HtmlOptions<B> = {} as HtmlOptions<B>): string {
  const component = (options.components as Record<string, HtmlComponent<AnyBlock> | undefined> | undefined)?.[block.type];
  if(component) return String(component(block, options));
  if(isBuiltInType(block.type)) return renderBuiltIn(block, options);
  return missing(block.type);
}

/** A page's blocks as HTML, in order. */
export function renderBlocks<B extends AnyBlock>(blocks: readonly B[] | null | undefined, options: HtmlOptions<B> = {} as HtmlOptions<B>): string {
  return (blocks ?? []).map(block => renderBlock(block, options)).join("\n");
}
