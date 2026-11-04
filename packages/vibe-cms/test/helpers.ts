import { Database } from "bun:sqlite";
import type { D1, D1Statement, R2, R2Object } from "../src/handler/platform.ts";

/** A D1 stand-in over bun:sqlite, enough for the engine's needs. */
export function createD1(): D1 & { sqlite: Database } {
  const sqlite = new Database(":memory:");
  function statement(sql: string, params: unknown[] = []): D1Statement & { exec(): { results: unknown[] } } {
    function values() {
      // Like D1, which refuses `undefined` rather than binding NULL.
      if(params.includes(undefined)) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      return params as never[];
    }
    return {
      bind: (...next: unknown[]) => statement(sql, next),
      all: async () => ({ results: sqlite.query(sql).all(...values()) }),
      raw: async () => sqlite.query(sql).values(...values()) as unknown[][],
      first: async () => sqlite.query(sql).get(...values()) ?? null,
      run: async () => sqlite.query(sql).run(...values()),
      exec: () => ({ results: sqlite.query(sql).all(...values()) })
    };
  }
  return {
    sqlite,
    prepare: sql => statement(sql),
    batch: async statements => sqlite.transaction(() => statements.map(s => (s as ReturnType<typeof statement>).exec()))()
  };
}

export function createR2(): R2 & { objects: Map<string, { data: Uint8Array<ArrayBuffer>, type?: string }> } {
  const objects = new Map<string, { data: Uint8Array<ArrayBuffer>, type?: string }>();
  const uploads = new Map<string, { key: string, type?: string, parts: Map<number, Uint8Array> }>();
  return {
    objects,
    async put(key, value, options) {
      const data = value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
        : value instanceof ArrayBuffer ? new Uint8Array(value)
          : value instanceof Uint8Array ? new Uint8Array(value)
            : new Uint8Array(await new Response(value).arrayBuffer());
      objects.set(key, { data, type: options?.httpMetadata?.contentType });
    },
    async get(key) {
      const object = objects.get(key);
      if(!object) return null;
      return {
        body: new Response(object.data).body!,
        httpEtag: `"${key}"`,
        size: object.data.byteLength,
        httpMetadata: { contentType: object.type }
      } satisfies R2Object;
    },
    async delete(key) {
      objects.delete(key);
    },
    async head(key) {
      const object = objects.get(key);
      return object ? { httpEtag: `"${key}-${object.data.byteLength}"`, size: object.data.byteLength, httpMetadata: { contentType: object.type } } : null;
    },
    async createMultipartUpload(key, options) {
      const uploadId = `up-${uploads.size + 1}`;
      uploads.set(uploadId, { key, type: options?.httpMetadata?.contentType, parts: new Map() });
      return this.resumeMultipartUpload!(key, uploadId);
    },
    resumeMultipartUpload(key, uploadId) {
      return {
        uploadId,
        async uploadPart(partNumber, value) {
          const data = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
          uploads.get(uploadId)!.parts.set(partNumber, data);
          return { partNumber, etag: `part-${partNumber}` };
        },
        async complete(parts) {
          const upload = uploads.get(uploadId)!;
          const chunks = parts.map(part => upload.parts.get(part.partNumber)!);
          const data = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let offset = 0;
          for(const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
          }
          objects.set(key, { data, type: upload.type });
          uploads.delete(uploadId);
        },
        async abort() {
          uploads.delete(uploadId);
        }
      };
    }
  };
}

/** A 1x1 PNG with the given dimensions written into its IHDR. */
export function png(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

export const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch(() => {}) };
