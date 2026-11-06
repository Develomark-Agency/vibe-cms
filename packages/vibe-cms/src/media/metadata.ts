/**
 * Location and camera details in photos (EXIF, XMP, IPTC): finding them, which the editor does in
 * the browser before uploading (and shows in full with exifr), and removing them, which the server
 * does on upload. Byte-level, no
 * re-encoding: pixels are untouched. Orientation is kept, or phone photos would turn sideways.
 */

export interface PhotoMetadata {
  /** GPS coordinates. */
  location: boolean,
  /** Camera make, model, or serial. */
  camera: boolean,
  /** Any EXIF, XMP or IPTC at all. */
  any: boolean,
  /** EXIF orientation, 1–8, when it isn't the default 1. */
  orientation?: number
}

const NONE: PhotoMetadata = { location: false, camera: false, any: false };

/** The image types read and cleaned here. */
export function hasMetadataSupport(mime: string): boolean {
  return mime === "image/jpeg" || mime === "image/png" || mime === "image/webp";
}

const TAG_ORIENTATION = 0x0112;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_GPS = 0x8825;
const TAG_EXIF_IFD = 0x8769;
const TAG_SERIAL = 0xa431;

/** Reads IFD0 (and the Exif sub-IFD for the body serial) of a TIFF block. */
function readTiff(b: Uint8Array): PhotoMetadata {
  if(b.length < 8) return { ...NONE, any: true };
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const little = b[0] === 0x49;
  function u16(at: number) {
    return view.getUint16(at, little);
  }
  function u32(at: number) {
    return view.getUint32(at, little);
  }
  const result: PhotoMetadata = { location: false, camera: false, any: true };
  function walk(offset: number, first: boolean) {
    if(offset + 2 > b.length) return;
    const count = u16(offset);
    for(let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      if(entry + 12 > b.length) return;
      const tag = u16(entry);
      if(tag === TAG_GPS) result.location = true;
      if(tag === TAG_MAKE || tag === TAG_MODEL || tag === TAG_SERIAL) result.camera = true;
      if(first && tag === TAG_ORIENTATION) {
        const value = u16(entry + 8);
        if(value > 1 && value <= 8) result.orientation = value;
      }
      if(first && tag === TAG_EXIF_IFD) walk(u32(entry + 8), false);
    }
  }
  try {
    walk(u32(4), true);
  } catch {
    // A truncated block (the browser reads only the start of the file) still counts as metadata.
  }
  return result;
}

/** A minimal big-endian TIFF block holding only the orientation tag. */
function orientationTiff(orientation: number): Uint8Array {
  return Uint8Array.from([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // "MM", 42, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00 // no next IFD
  ]);
}

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

function ascii(b: Uint8Array, at: number, length: number): string {
  return String.fromCharCode(...b.subarray(at, at + length));
}

function startsWith(b: Uint8Array, at: number, bytes: number[]): boolean {
  return bytes.every((byte, i) => b[at + i] === byte);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for(const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function merge(a: PhotoMetadata, b: PhotoMetadata): PhotoMetadata {
  return {
    location: a.location || b.location,
    camera: a.camera || b.camera,
    any: a.any || b.any,
    ...(a.orientation ?? b.orientation ? { orientation: a.orientation ?? b.orientation } : {})
  };
}

// --- JPEG -------------------------------------------------------------------------

const APP1 = 0xe1;
const APP13 = 0xed;
const COM = 0xfe;
const SOS = 0xda;

/** Segments before the image data, as [marker, start, end]. Stops at start-of-scan. */
function jpegSegments(b: Uint8Array): Array<[number, number, number]> {
  const segments: Array<[number, number, number]> = [];
  let at = 2;
  while(at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    if(marker === SOS) break;
    const end = at + 2 + ((b[at + 2]! << 8) | b[at + 3]!);
    segments.push([marker, at, Math.min(end, b.length)]);
    at = end;
  }
  return segments;
}

function jpegMetadata(b: Uint8Array): PhotoMetadata {
  let found = NONE;
  for(const [marker, start, end] of jpegSegments(b)) {
    if(marker === APP1 && startsWith(b, start + 4, EXIF_HEADER)) found = merge(found, readTiff(b.subarray(start + 10, end)));
    else if(marker === APP1 || marker === APP13) found = merge(found, { ...NONE, any: true });
  }
  return found;
}

function stripJpeg(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const segments = jpegSegments(b);
  const found = jpegMetadata(b);
  if(!found.any && !segments.some(([marker]) => marker === COM)) return null;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let insertedOrientation = !found.orientation;
  let last = 2;
  for(const [marker, start, end] of segments) {
    const drop = marker === APP1 || marker === APP13 || marker === COM;
    if(drop) {
      parts.push(b.subarray(last, start));
      last = end;
      if(!insertedOrientation) {
        const payload = concat([Uint8Array.from(EXIF_HEADER), orientationTiff(found.orientation!)]);
        const length = payload.length + 2;
        parts.push(Uint8Array.from([0xff, APP1, length >> 8, length & 0xff]), payload);
        insertedOrientation = true;
      }
    }
  }
  parts.push(b.subarray(last));
  return concat(parts);
}

// --- PNG --------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Chunks as [type, start, end], `end` past the CRC. */
function pngChunks(b: Uint8Array): Array<[string, number, number]> {
  const chunks: Array<[string, number, number]> = [];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 8;
  while(at + 8 <= b.length) {
    const length = view.getUint32(at);
    const type = ascii(b, at + 4, 4);
    chunks.push([type, at, Math.min(at + 12 + length, b.length)]);
    if(type === "IDAT" || type === "IEND") break;
    at += 12 + length;
  }
  return chunks;
}

function isXmpText(b: Uint8Array, start: number): boolean {
  return ascii(b, start + 8, 17) === "XML:com.adobe.xmp";
}

function pngMetadata(b: Uint8Array): PhotoMetadata {
  let found = NONE;
  for(const [type, start, end] of pngChunks(b)) {
    if(type === "eXIf") found = merge(found, readTiff(b.subarray(start + 8, end - 4)));
    else if(type === "iTXt" && isXmpText(b, start)) found = merge(found, { ...NONE, any: true });
  }
  return found;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if(!crcTable) {
    crcTable = new Uint32Array(256);
    for(let n = 0; n < 256; n++) {
      let c = n;
      for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for(const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for(let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function stripPng(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const found = pngMetadata(b);
  if(!found.any) return null;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let last = 8;
  for(const [type, start, end] of pngChunks(b)) {
    if(type === "eXIf" || (type === "iTXt" && isXmpText(b, start))) {
      parts.push(b.subarray(last, start));
      last = end;
    }
  }
  parts.push(b.subarray(last));
  const out = concat(parts);
  if(!found.orientation) return out;
  // eXIf goes before the image data: put it right after IHDR.
  const ihdrEnd = 8 + 12 + new DataView(out.buffer).getUint32(8);
  return concat([out.subarray(0, ihdrEnd), pngChunk("eXIf", orientationTiff(found.orientation)), out.subarray(ihdrEnd)]);
}

// --- WebP -------------------------------------------------------------------------

function webpChunks(b: Uint8Array): Array<[string, number, number]> {
  const chunks: Array<[string, number, number]> = [];
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 12;
  while(at + 8 <= b.length) {
    const size = view.getUint32(at + 4, true);
    const end = Math.min(at + 8 + size + (size & 1), b.length);
    chunks.push([ascii(b, at, 4), at, end]);
    at = end;
  }
  return chunks;
}

function webpMetadata(b: Uint8Array): PhotoMetadata {
  let found = NONE;
  for(const [type, start, end] of webpChunks(b)) {
    if(type === "EXIF") {
      const data = b.subarray(start + 8, end);
      found = merge(found, readTiff(startsWith(data, 0, EXIF_HEADER) ? data.subarray(6) : data));
    } else if(type === "XMP ") found = merge(found, { ...NONE, any: true });
  }
  return found;
}

function stripWebp(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const found = webpMetadata(b);
  if(!found.any) return null;
  const kept: Uint8Array[] = [];
  for(const [type, start, end] of webpChunks(b)) {
    if(type === "EXIF" || type === "XMP ") continue;
    kept.push(new Uint8Array(b.subarray(start, end)));
  }
  if(found.orientation) {
    const data = orientationTiff(found.orientation);
    const chunk = new Uint8Array(8 + data.length);
    chunk.set([0x45, 0x58, 0x49, 0x46]); // "EXIF"
    new DataView(chunk.buffer).setUint32(4, data.length, true);
    chunk.set(data, 8);
    kept.push(chunk);
  }
  // VP8X flags say which optional chunks follow: XMP (bit 2) is gone; EXIF (bit 3) only with orientation.
  for(const chunk of kept) {
    if(ascii(chunk, 0, 4) === "VP8X") chunk[8] = (chunk[8]! & ~0x04 & ~0x08) | (found.orientation ? 0x08 : 0);
  }
  const body = concat(kept);
  const header = new Uint8Array(12);
  header.set(b.subarray(0, 12));
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  return concat([header, body]);
}

// --- Entry points -----------------------------------------------------------------

/**
 * What metadata a photo carries. Reading the first 256 KB is enough: it all comes before the image data.
 */
export function readMetadata(bytes: Uint8Array, mime: string): PhotoMetadata {
  try {
    if(mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegMetadata(bytes);
    if(mime === "image/png" && startsWith(bytes, 0, PNG_SIGNATURE)) return pngMetadata(bytes);
    if(mime === "image/webp" && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return webpMetadata(bytes);
  } catch {
    // Unreadable headers: nothing found, and stripping leaves the file alone.
  }
  return NONE;
}

/** The photo without its metadata (orientation kept), or null when there was none to remove. */
export function stripMetadata(bytes: Uint8Array, mime: string): Uint8Array<ArrayBuffer> | null {
  try {
    if(mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) return stripJpeg(bytes);
    if(mime === "image/png" && startsWith(bytes, 0, PNG_SIGNATURE)) return stripPng(bytes);
    if(mime === "image/webp" && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return stripWebp(bytes);
  } catch {
    // Malformed: stored as uploaded rather than risk breaking it.
  }
  return null;
}
