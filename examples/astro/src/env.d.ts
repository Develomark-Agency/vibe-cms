interface Env {
  DB: D1Database,
  MEDIA: R2Bucket,
  ASSETS: Fetcher
}

declare namespace Cloudflare {
  interface Env extends globalThis.Env {}
}
