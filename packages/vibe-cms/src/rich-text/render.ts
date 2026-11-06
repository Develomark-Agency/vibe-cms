import { field } from "../preview/index.ts";
import type { Block, InlineNode, Mark, RichTextDoc, RichTextOutput } from "./schema.ts";

export interface RenderOptions {
  /** URL for a link to another document. Defaults to `#type-id`. */
  linkTo?: (ref: { type: string, id: string }) => string
}

const tags: Record<Mark, string> = { bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" };

function escape(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

function safeHref(href: string): string {
  return /^(https?:|mailto:|tel:|\/|#)/i.test(href.trim()) ? href : "#";
}

function inline(nodes: InlineNode[], options: RenderOptions): string {
  return nodes.map(node => {
    if(node.kind === "link") {
      const href = node.to ? (options.linkTo?.(node.to) ?? `#${node.to.type}-${node.to.id}`) : safeHref(node.href ?? "#");
      const external = /^https?:/i.test(href) ? " rel=\"noopener\"" : "";
      return `<a href="${escape(href)}"${external}>${inline(node.children, options)}</a>`;
    }
    let html = escape(node.text).replace(/\n/g, "<br>");
    for(const mark of node.marks ?? []) html = `<${tags[mark]}>${html}</${tags[mark]}>`;
    return html;
  }).join("");
}

/**
 * Renders a rich text document as HTML. Images need the query's resolved asset (with `url`). In an
 * editor's draft preview, each paragraph, heading, list and image says which field it's from, for the
 * preview's picker (`vibe-cms docs preview`).
 */
export function renderRichText(doc: RichTextDoc | RichTextOutput | null | undefined, options: RenderOptions = {}): string {
  return ((doc ?? []) as Block[]).map((node: Block, i) => {
    const at = doc ? field.attribute(doc as Block[], i) : "";
    switch(node.kind) {
      case "p": return `<p${at}>${inline(node.children, options)}</p>`;
      case "h": return `<h${node.level}${at}>${inline(node.children, options)}</h${node.level}>`;
      case "quote": return `<blockquote${at}>${inline(node.children, options)}</blockquote>`;
      case "list": {
        const tag = node.ordered ? "ol" : "ul";
        return `<${tag}${at}>${node.items.map(item => `<li>${inline(item, options)}</li>`).join("")}</${tag}>`;
      }
      case "image": {
        const asset = node.asset as typeof node.asset & { url?: string, width?: number, height?: number };
        if(!asset.url) return "";
        const size = asset.width && asset.height ? ` width="${asset.width}" height="${asset.height}"` : "";
        return `<figure${at}><img src="${escape(asset.url)}" alt="${escape(asset.alt ?? "")}"${size} loading="lazy"></figure>`;
      }
      default: return "";
    }
  }).join("\n");
}

/** Plain text, e.g. for excerpts or search indexing. */
export function toPlainText(input: RichTextDoc | RichTextOutput | null | undefined): string {
  const doc = input as RichTextDoc | null | undefined;
  function text(nodes: InlineNode[]): string {
    return nodes.map(n => (n.kind === "link" ? text(n.children) : n.text)).join("");
  }
  return (doc ?? []).map(node => {
    if(node.kind === "list") return node.items.map(text).join("\n");
    if(node.kind === "image") return "";
    return text(node.children);
  }).filter(Boolean).join("\n\n");
}
