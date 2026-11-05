import { eq } from "drizzle-orm";
import { fetchDescriptor, PanelError, type PanelSite } from "vibe-cms/panel";
import { applyTemplate, defaultTemplateId, grantAdder, requirePermission, type HubAccess } from "./access.ts";
import { apiBase, hubOrg } from "./hub.ts";
import * as t from "./schema.ts";
import { db, type Env } from "./shared.ts";

/**
 * Adding sites to the hub. A site joins by trusting the hub's org (`VIBE_ORG`, or a claim) and then being
 * added by its address; whoever adds it manages it, and a template can write its starting roles.
 */

export interface AddedSite extends PanelSite {
  template: Awaited<ReturnType<typeof applyTemplate>> | null
}

/** Adds a site that already trusts this hub's org. */
export async function addSite(env: Env, me: HubAccess, input: { url: string, templateId?: string | null }): Promise<AddedSite> {
  requirePermission(me, "addSites");
  const descriptor = await fetchDescriptor(input.url);
  // The site has to have agreed to trust this hub's org.
  const org = hubOrg(env);
  if(descriptor.org !== org) {
    throw new PanelError(422, descriptor.org
      ? `This site trusts another org (${descriptor.org}), not ${org}`
      : `This site doesn't belong to an org yet. Attach it with the claim link it logged when it was deployed, or set VIBE_ORG=${org} in its environment and deploy it.`);
  }
  const site: PanelSite = { id: descriptor.id, url: new URL(descriptor.admin).origin, name: descriptor.name, admin: descriptor.admin, favorite: false };
  const [existing] = await db(env).select({ id: t.sites.id }).from(t.sites).where(eq(t.sites.id, site.id));
  await db(env).insert(t.sites)
    .values({ id: site.id, url: site.url, name: site.name, admin: site.admin, org: descriptor.org, added_by: me.sub, added_at: Date.now() })
    .onConflictDoUpdate({ target: t.sites.id, set: { url: site.url, name: site.name, admin: site.admin, org: descriptor.org } });
  if(existing) return { ...site, template: null };
  // Whoever adds a site manages it; then its starting roles, copied from a template.
  await grantAdder(env, site.id, me.sub);
  const templateId = input.templateId === undefined ? await defaultTemplateId(env) : input.templateId;
  const template = templateId ? await applyTemplate(env, site, templateId, me.sub) : null;
  return { ...site, template };
}

/**
 * Reads a claim link as the site logs it: the site's address, and the token after `#claim=`. A bare
 * address with the fragment works too (`client.com#claim=…`).
 */
export function parseClaimLink(link: string): { url: string, token: string } {
  const text = link.trim();
  const url = URL.canParse(text) && /^https?:\/\//i.test(text) ? new URL(text) : URL.canParse(`https://${text}`) ? new URL(`https://${text}`) : null;
  const token = url ? new URLSearchParams(url.hash.slice(1)).get("claim") : null;
  if(!url || !token) throw new PanelError(400, "That isn't a claim link. A site logs one when it's deployed without VIBE_ORG: an address ending in #claim=…");
  return { url: url.origin, token };
}

/**
 * Claims a site that has no org for this hub's org, then adds it. The site checks the claim link's
 * token, and that this org's hub resolves and serves keys (the DNS record is in place), before it
 * takes the org. A site already in this org is just added, so running it twice is safe.
 */
export async function attachSite(env: Env, me: HubAccess, input: { link: string, templateId?: string | null }): Promise<AddedSite> {
  requirePermission(me, "addSites");
  const { url, token } = parseClaimLink(input.link);
  const org = hubOrg(env);
  const descriptor = await fetchDescriptor(url);
  if(descriptor.org && descriptor.org !== org) throw new PanelError(422, `This site already trusts another org (${descriptor.org}), not ${org}`);
  if(descriptor.org !== org) {
    const response = await fetch(`${apiBase(descriptor)}/api/org/claim`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, org })
    }).catch(() => null);
    if(!response) throw new PanelError(502, `Couldn't reach ${url}`);
    if(!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      throw new PanelError([400, 401, 409, 422].includes(response.status) ? response.status : 502, data.error ?? `The site refused the claim (${response.status})`);
    }
  }
  return addSite(env, me, { url, templateId: input.templateId });
}
