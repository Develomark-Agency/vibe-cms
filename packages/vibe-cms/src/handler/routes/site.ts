import { Hono } from "hono";
import { serializeConfig, type AnyConfig } from "../../config.ts";
import type { OrgStatus } from "../../org/index.ts";
import { Engine, type SiteSettings } from "../engine.ts";
import { signInMode } from "../signin.ts";
import { cors, json, type SiteEnv } from "../http.ts";

export function descriptor(config: AnyConfig, url: URL, prefix: string, site: SiteSettings, org: OrgStatus) {
  return {
    protocol: 1,
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
    admin: `${url.origin}${prefix}/admin`
  };
}

/** `/.well-known/vibe-cms`: how an agency panel recognises a site. Public, at the site's root. */
export const discovery = new Hono<SiteEnv>();

discovery.use("/.well-known/vibe-cms", cors);
discovery.get("/.well-known/vibe-cms", async c => {
  const { state, ctx } = c.env;
  const url = new URL(c.req.url);
  const site = await new Engine(state, { origin: url.origin, session: null, trusted: false, ctx }).site();
  return json(descriptor(state.config, url, state.prefix, site, await state.org.status()), { headers: { "cache-control": "public, max-age=60" } });
});

/** `GET /info`: what the editor needs to start: the config, the sign-in mode, the site's settings. */
export const info = new Hono<SiteEnv>()
  .get("/info", async c => {
    const { state, dev } = c.env;
    const site = await c.get("engine").site();
    const org = await state.org.status();
    return c.json({
      ...serializeConfig(state.config),
      prefix: state.prefix,
      dev,
      hub: org.hub,
      signIn: await signInMode(state),
      site: descriptor(state.config, new URL(c.req.url), state.prefix, site, org),
      settings: site
    });
  });
