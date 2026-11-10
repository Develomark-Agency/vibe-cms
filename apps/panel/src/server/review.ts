import type { PanelReview } from "vibe-cms/panel";
import * as t from "./schema.ts";
import { apiBase, userToken } from "./hub.ts";
import { db, type Env, type SessionRow } from "./shared.ts";
import { hubAccess, visibleSiteIds } from "./access.ts";

/** How long to wait for one site before listing it as unreachable. */
const SITE_TIMEOUT = 8000;

/**
 * Every visible site's documents with unpublished changes, asked of each site as this person, so
 * each site applies its own permissions. A site that can't answer is listed with why.
 */
export async function review(env: Env, session: SessionRow): Promise<PanelReview> {
  const visible = await visibleSiteIds(env, await hubAccess(env, session));
  const sites = (await db(env).select({ id: t.sites.id, name: t.sites.name, admin: t.sites.admin }).from(t.sites).orderBy(t.sites.name))
    .filter(site => visible === "all" || visible.has(site.id));
  return {
    sites: await Promise.all(sites.map(async site => {
      const entry = { site: { id: site.id, name: site.name } };
      try {
        const response = await fetch(`${apiBase(site)}/api/actions/documents.pending`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${await userToken(env, session, site.id)}`, "x-vibe-client": "vibe-panel" },
          body: "{}",
          signal: AbortSignal.timeout(SITE_TIMEOUT)
        });
        const body = await response.json().catch(() => ({})) as { documents?: PanelReview["sites"][number]["documents"], error?: string };
        // An older site has no such action; it just has nothing to list here.
        if(response.status === 404) return { ...entry, documents: [] };
        if(!response.ok || !body.documents) return { ...entry, documents: [], error: body.error ?? `The site answered ${response.status}` };
        return { ...entry, documents: body.documents };
      } catch (error) {
        return { ...entry, documents: [], error: error instanceof Error && error.name === "TimeoutError" ? "The site didn't answer" : "Couldn't reach the site" };
      }
    }))
  };
}
