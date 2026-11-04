import { Hono } from "hono";
import type { SiteContext, SiteEnv } from "../http.ts";

/** The editor is static assets; deep links fall back to its index.html. */
export const admin = new Hono<SiteEnv>();

async function serveAdmin(c: SiteContext) {
  const { state, assets } = c.env;
  const url = new URL(c.req.url);
  const index = `${state.prefix}/admin/`;
  if(url.pathname === `${state.prefix}/admin`) return Response.redirect(`${url.origin}${index}${url.search}${url.hash}`, 302);
  if(!assets) {
    return new Response(
      "vibe-cms: the editor is served from static assets. Build with the vibe() Vite plugin, "
      + "and pass `assets: env.ASSETS` in createHandler bindings if your assets binding isn't named ASSETS.",
      { status: 404 }
    );
  }
  const response = await assets.fetch(new Request(new URL(index, url.origin), { headers: c.req.raw.headers }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-cache");
  return new Response(response.body, { status: response.ok ? 200 : response.status, headers });
}

admin.all("/admin", serveAdmin);
admin.all("/admin/*", serveAdmin);
