type SiteEnv = typeof import("../alchemy.run.ts").site.Env;

declare namespace Cloudflare {
  interface Env extends SiteEnv {}
}
