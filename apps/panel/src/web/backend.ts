import { hc } from "hono/client";
import { DEFAULT_BRANDING, normalizeBranding, PanelError, type PanelBackend } from "vibe-cms/panel";
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
    addSite: async url => read(await api.sites.$post({ json: { url } })),
    removeSite: async id => done(await api.sites[":id"].$delete({ param: { id } })),
    setFavorite: async (id, favorite) => {
      const route = api.sites[":id"].favorite;
      await done(favorite ? await route.$put({ param: { id } }) : await route.$delete({ param: { id } }));
    },
    codeFor: async id => (await read(await api.sites[":id"].code.$post({ param: { id } }))).code,
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
    signInUrl: auth.login.$url().toString(),
    signOut: async () => done(await auth.logout.$post())
  };
}
