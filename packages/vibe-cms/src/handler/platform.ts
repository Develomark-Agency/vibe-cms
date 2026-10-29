/**
 * The slices of Cloudflare's runtime APIs the engine uses. Declared
 * structurally so the package doesn't depend on a particular version of
 * `@cloudflare/workers-types` or on `wrangler types` output.
 */

export interface D1Statement {
  bind(...values: unknown[]): D1Statement,
  all(): Promise<{ results: unknown[] }>,
  first(): Promise<unknown>,
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

export interface R2 {
  put(key: string, value: ArrayBuffer | ReadableStream | Uint8Array | Blob, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>,
  get(key: string): Promise<R2Object | null>,
  delete(key: string): Promise<void>
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
