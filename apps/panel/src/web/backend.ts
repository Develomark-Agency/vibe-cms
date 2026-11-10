import { hc } from "hono/client";
import { DEFAULT_BRANDING, normalizeBranding, PanelError, type PanelBackend, type PanelHub, type RoleTemplate, type SiteAccessInfo, type TemplateResult } from "vibe-cms/panel";
import type { PanelApi } from "../server/index.ts";

interface Reply<T> {
  ok: boolean,
  status: number,
  statusText: string,
  json(): Promise<T>
}

/** The reply's JSON, or a `PanelError` carrying the server's message. */
async function read<T>(reply: Reply<T>): Promise<T> {
  if(!reply.ok) {
    const data = await (reply as Reply<{ error?: string } | null>).json().catch(() => null);
    throw new PanelError(reply.status, data?.error ?? reply.statusText);
  }
  return reply.json();
}

/** For replies with no body (204). */
async function done(reply: Reply<unknown>): Promise<void> {
  if(!reply.ok) await read(reply);
}

/** The hosted panel: everything goes through the panel's own backend, typed by its routes (`PanelApi`). */
export function hostedBackend(base = location.origin, fetch?: typeof globalThis.fetch): PanelBackend {
  const client = hc<PanelApi>(base, { fetch, init: { credentials: "same-origin" } });
  const { api, auth } = client;
  return {
    mode: "hosted",
    async branding() {
      try {
        return normalizeBranding(await read(await api.branding.$get()));
      } catch {
        return DEFAULT_BRANDING;
      }
    },
    async me() {
      try {
        return await read(await api.me.$get());
      } catch (error) {
        if(error instanceof PanelError && error.status === 401) return null;
        throw error;
      }
    },
    sites: async () => read(await api.sites.$get()),
    addSite: async (url, templateId) => read(await api.sites.$post({ json: { url, templateId } })),
    attachSite: async (link, templateId) => read(await api.sites.attach.$post({ json: { link, templateId } })),
    removeSite: async id => done(await api.sites[":id"].$delete({ param: { id } })),
    setFavorite: async (id, favorite) => {
      const route = api.sites[":id"].favorite;
      await done(favorite ? await route.$put({ param: { id } }) : await route.$delete({ param: { id } }));
    },
    codeFor: async id => (await read(await api.sites[":id"].code.$post({ param: { id } }))).code,
    review: async () => read(await api.review.$get()),
    agents: async () => read(await api.agents.$get()),
    disconnectAgent: async id => done(await api.agents[":id"].$delete({ param: { id } })),
    backups: {
      status: async () => read(await api.backups.$get()),
      setDefaults: async policy => done(await api.backups.defaults.$put({ json: { policy } })),
      site: async id => read(await api.sites[":id"].backups.$get({ param: { id } })),
      setPolicy: async (id, policy) => read(await api.sites[":id"].backups.policy.$put({ param: { id }, json: { policy } })),
      downloadUrl: snapshot => api.backups.download.$url({ query: { snapshot } }).toString(),
      backUp: async id => done(await api.sites[":id"].backups.$post({ param: { id } })),
      restore: async (id, snapshot) => done(await api.sites[":id"].backups.restore.$post({ param: { id }, json: { snapshot } }))
    },
    hub: {
      setup: async () => read(await api.setup.$get()),
      members: async () => read(await api.members.$get()) as unknown as Awaited<ReturnType<PanelHub["members"]>>,
      invite: async (email, role) => void await read(await api.members.$post({ json: { email, role } })),
      setMemberRole: async (id, role) => void await read(await api.members[":id"].$patch({ param: { id }, json: { role } })),
      removeMember: async id => done(await api.members[":id"].$delete({ param: { id } })),
      saveHubRole: async (name, permissions) => void await read(await api["hub-roles"][":name"].$put({ param: { name }, json: { permissions } })),
      deleteHubRole: async name => void await read(await api["hub-roles"][":name"].$delete({ param: { name } })),
      siteAccess: async id => read(await api.sites[":id"].access.$get({ param: { id } })) as unknown as SiteAccessInfo,
      assign: async (id, who, roles) => void await read(await api.sites[":id"].assignments.$put({ param: { id }, json: { ...who, roles } })),
      unassign: async (id, principal) => done(await api.sites[":id"].assignments[":principal"].$delete({ param: { id, principal } })),
      addOwner: async (id, sub) => done(await api.sites[":id"].owners.$post({ param: { id }, json: { sub } })),
      removeOwner: async (id, sub) => done(await api.sites[":id"].owners[":sub"].$delete({ param: { id, sub } })),
      applyTemplate: async (id, templateId, replace) => read(await api.sites[":id"].template.$post({ param: { id }, json: { templateId, replace } })) as Promise<TemplateResult>,
      templates: async () => (await read(await api.templates.$get())).templates as RoleTemplate[],
      saveTemplate: async (id, input) => (id
        ? read(await api.templates[":id"].$put({ param: { id }, json: input }))
        : read(await api.templates.$post({ json: input }))) as Promise<RoleTemplate>,
      deleteTemplate: async id => done(await api.templates[":id"].$delete({ param: { id } }))
    },
    signInUrl: auth.login.$url().toString(),
    signOut: async () => done(await auth.logout.$post())
  };
}
