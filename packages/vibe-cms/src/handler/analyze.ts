import type { AssetMeta } from "../schema/types.ts";
import { textMime } from "../text-files.ts";

/** Core `media.analyze` for images: reads dimensions from file headers. */
export function analyzeImage(bytes: Uint8Array, mime: string): AssetMeta {
  const size = readImageSize(bytes, mime);
  return size ? { width: size[0], height: size[1] } : {};
}

function readImageSize(b: Uint8Array, mime: string): [number, number] | undefined {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG: IHDR right after the 8-byte signature.
  if(b[0] === 0x89 && b[1] === 0x50 && b.length >= 24) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  // GIF
  if(b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b.length >= 10) {
    return [view.getUint16(6, true), view.getUint16(8, true)];
  }
  // JPEG: walk segments to the first start-of-frame marker.
  if(b[0] === 0xff && b[1] === 0xd8) {
    let offset = 2;
    while(offset + 9 < b.length) {
      if(b[offset] !== 0xff) return undefined;
      const marker = b[offset + 1]!;
      const length = view.getUint16(offset + 2);
      if(marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [view.getUint16(offset + 7), view.getUint16(offset + 5)];
      }
      offset += 2 + length;
    }
    return undefined;
  }
  // WebP: RIFF....WEBP then VP8 / VP8L / VP8X chunk.
  if(b.length >= 30 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const chunk = ascii(b, 12, 4);
    if(chunk === "VP8 ") return [view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff];
    if(chunk === "VP8L") {
      const bits = view.getUint32(21, true);
      return [(bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1];
    }
    if(chunk === "VP8X") {
      return [1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16))];
    }
  }
  if(mime === "image/svg+xml") {
    const head = new TextDecoder().decode(b.subarray(0, 2048));
    const width = /<svg[^>]*\swidth="([\d.]+)/.exec(head)?.[1];
    const height = /<svg[^>]*\sheight="([\d.]+)/.exec(head)?.[1];
    if(width && height) return [Number(width), Number(height)];
    const viewBox = /<svg[^>]*\sviewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(head);
    if(viewBox) return [Number(viewBox[1]), Number(viewBox[2])];
  }
  return undefined;
}

function ascii(b: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...b.subarray(start, start + length));
}

export function mimeMatches(mime: string, patterns: readonly string[] | undefined): boolean {
  if(!patterns?.length) return true;
  return patterns.some(pattern => pattern === "*" || pattern === "*/*" || pattern === mime
    || (pattern.endsWith("/*") && mime.startsWith(pattern.slice(0, -1))));
}

const extensions: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "application/pdf": "pdf"
};

/** A MIME type from a file name's extension, for files that arrive without one. */
export function mimeFor(filename: string): string | null {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1]?.toLowerCase();
  if(!extension) return null;
  if(extension === "jpeg") return "image/jpeg";
  return Object.entries(extensions).find(([, ext]) => ext === extension)?.[0] ?? textMime(filename);
}

export function extensionFor(mime: string, filename: string): string {
  const fromName = /\.([a-z0-9]{1,8})$/i.exec(filename)?.[1];
  return (fromName ?? extensions[mime] ?? "bin").toLowerCase();
}
