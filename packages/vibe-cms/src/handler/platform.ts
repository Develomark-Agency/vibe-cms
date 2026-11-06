/**
 * The slices of Cloudflare's runtime APIs the engine uses. Declared
 * structurally so the package doesn't depend on a particular version of
 * `@cloudflare/workers-types` or on `wrangler types` output.
 */

export interface D1Statement {
  bind(...values: unknown[]): D1Statement,
  all(): Promise<{ results: unknown[] }>,
  first(): Promise<unknown>,
  /** Rows as arrays of values, in column order. Drizzle reads results this way. */
  raw(): Promise<unknown[][]>,
  run(): Promise<unknown>
}

export interface D1 {
  prepare(query: string): D1Statement,
  batch(statements: D1Statement[]): Promise<Array<{ results?: unknown[] }>>
}

export interface R2Object {
  body: ReadableStream,
  httpEtag: string,
  size: number,
  httpMetadata?: { contentType?: string }
}

export interface R2MultipartUpload {
  uploadId: string,
  uploadPart(partNumber: number, value: ReadableStream | ArrayBuffer | Uint8Array | Blob): Promise<{ partNumber: number, etag: string }>,
  complete(parts: Array<{ partNumber: number, etag: string }>): Promise<unknown>,
  abort(): Promise<void>
}

export interface R2 {
  put(key: string, value: ArrayBuffer | ReadableStream | Uint8Array | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>,
  get(key: string): Promise<R2Object | null>,
  delete(key: string): Promise<void>,
  /** Size and etag without the body. Backups use it to skip files that are already there. */
  head?(key: string): Promise<Omit<R2Object, "body"> | null>,
  /** For files too large for one request body. Backups restore large media in parts with it. */
  createMultipartUpload?(key: string, options?: { httpMetadata?: { contentType?: string } }): Promise<R2MultipartUpload>,
  resumeMultipartUpload?(key: string, uploadId: string): R2MultipartUpload
}

export interface Fetcher {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void,
  passThroughOnException?(): void
}

export interface ScheduledEvent {
  cron: string,
  scheduledTime: number
}

export interface MessageBatch<T = unknown> {
  queue: string,
  messages: ReadonlyArray<{ id: string, body: T, ack(): void, retry(): void }>,
  ackAll(): void,
  retryAll(): void
}

/** What `env.IMAGES.input(…).transform(…).output(…)` resolves to. */
export interface ImagesResult {
  response(): Response,
  contentType(): string
}

export interface ImagesTransformer {
  transform(options: { width?: number, height?: number, fit?: "scale-down" | "contain" | "cover" | "crop" | "pad" }): ImagesTransformer,
  output(options: { format: string, quality?: number }): Promise<ImagesResult>
}

/** Cloudflare's Images binding (`Images()` in Alchemy, `"images": { "binding": "IMAGES" }` in wrangler). */
export interface ImagesBinding {
  input(stream: ReadableStream): ImagesTransformer
}
