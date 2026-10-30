/**
 * Text files the media library previews and edits in place. Shared by the
 * engine (which accepts edits) and the editor (which picks a language).
 * SVG is deliberately absent: it's shown as an image.
 */
export type TextKind = "markdown" | "json" | "csv" | "yaml" | "xml" | "css" | "javascript" | "html" | "text";

const byExtension: Record<string, TextKind> = {
  txt: "text",
  text: "text",
  log: "text",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  json: "json",
  jsonc: "json",
  geojson: "json",
  webmanifest: "json",
  csv: "csv",
  tsv: "csv",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  rss: "xml",
  atom: "xml",
  css: "css",
  js: "javascript",
  mjs: "javascript",
  ts: "javascript",
  html: "html",
  htm: "html"
};

const mimeForKind: Record<TextKind, string> = {
  text: "text/plain",
  markdown: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  yaml: "application/yaml",
  xml: "application/xml",
  css: "text/css",
  javascript: "text/javascript",
  html: "text/html"
};

/** Files at most this large open in the editor. */
export const MAX_TEXT_EDIT_BYTES = 1024 * 1024;

export function textKind(filename: string, mime: string): TextKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  if(extension === "svg" || mime === "image/svg+xml") return null;
  if(extension && byExtension[extension]) return byExtension[extension];
  if(mime === "application/json" || mime.endsWith("+json")) return "json";
  if(mime === "text/csv") return "csv";
  if(mime === "text/markdown") return "markdown";
  if(mime.includes("yaml")) return "yaml";
  if(mime === "application/xml" || mime === "text/xml") return "xml";
  if(mime.startsWith("text/")) return "text";
  return null;
}

/** For uploads whose browser didn't know the type (often .md, .yaml, .csv). */
export function textMime(filename: string): string | null {
  const extension = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  const kind = extension ? byExtension[extension] : undefined;
  if(!kind) return null;
  return extension === "tsv" ? "text/tab-separated-values" : mimeForKind[kind];
}
