import { Hono } from "hono";
import { serializeConfig, type AnyConfig } from "../../config.ts";
import pkg from "../../../package.json" with { type: "json" };
import type { OrgStatus } from "../../org/index.ts";
import { Engine, type EngineState, type SiteSettings } from "../engine.ts";
import type { SiteWarning } from "../images.ts";
import { signInMode } from "../signin.ts";
import { cors, json, type SiteEnv } from "../http.ts";
import type { ExecutionContext } from "../platform.ts";

export function descriptor(config: AnyConfig, url: URL, prefix: string, site: SiteSettings, org: OrgStatus, warnings: SiteWarning[] = []) {
  return {
    protocol: 1,
    /** The Vibe CMS release the site runs, so a panel can tell which sites are behind. */
    version: pkg.version,
    id: site.id,
    name: site.name,
    accent: site.accent,
    icon: site.icon?.url ?? site.favicon,
    /** The org whose hub the site trusts (`VIBE_ORG`), and the hub's address. */
    org: org.org,
    hub: org.hub,
    /** A pending move to another org, which takes effect at `effectiveAt` unless cancelled. */
    orgMove: org.move,
    backups: config.backups === true,
    admin: `${url.origin}${prefix}/admin`,
    /** Setup problems a developer should fix, e.g. image optimization failing. */
    warnings
  };
}

/** The site's current warnings; checks image optimization again in the background when the last check is old. */
export async function siteWarnings(state: EngineState, ctx?: ExecutionContext): Promise<SiteWarning[]> {
  const health = state.imageHealth;
  if(!health) return [];
  await health.refresh(ctx).catch(() => {});
  return health.warnings(Boolean(state.storage)).catch(() => []);
}

/** `/.well-known/vibe-cms`: how an agency panel recognises a site. Public, at the site's root. */
export const discovery = new Hono<SiteEnv>();

discovery.use("/.well-known/vibe-cms", cors);
discovery.get("/.well-known/vibe-cms", async c => {
  const { state, ctx } = c.env;
  const url = new URL(c.req.url);
  const site = await new Engine(state, { origin: url.origin, session: null, trusted: false, ctx }).site();
  return json(descriptor(state.config, url, state.prefix, site, await state.org.status(), await siteWarnings(state, ctx)), { headers: { "cache-control": "public, max-age=60" } });
});

/** `GET /info`: what the editor needs to start: the config, the sign-in mode, the site's settings. */
export const info = new Hono<SiteEnv>()
  .get("/info", async c => {
    const { state, dev, ctx } = c.env;
    const site = await c.get("engine").site();
    const org = await state.org.status();
    return c.json({
      ...serializeConfig(state.config),
      prefix: state.prefix,
      dev,
      hub: org.hub,
      signIn: await signInMode(state),
      site: descriptor(state.config, new URL(c.req.url), state.prefix, site, org, await siteWarnings(state, ctx)),
      settings: site
    });
  });
