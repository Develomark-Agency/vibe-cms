/** A site as the panel knows it: from its `/.well-known/vibe-cms` descriptor. */
export interface PanelSite {
  id: string,
  url: string,
  name: string,
  admin: string,
  favorite: boolean
}

export interface PanelUser {
  name?: string,
  email?: string
}

export interface SiteDescriptor {
  protocol: number,
  id: string,
  name: string,
  auth: { issuer: string, clientId: string } | null,
  admin: string
}

/**
 * Where the panel keeps its state. The hosted panel talks to its own backend
 * (OIDC sign-in, shared site list in D1); the local panel keeps the list in
 * localStorage and relies on development sites signing editors in themselves.
 */
export interface PanelBackend {
  mode: "hosted" | "local",
  me(): Promise<PanelUser | null>,
  sites(): Promise<PanelSite[]>,
  addSite(url: string): Promise<PanelSite>,
  removeSite(id: string): Promise<void>,
  setFavorite(id: string, favorite: boolean): Promise<void>,
  /** A one-time code for the framed site. `null` when the site signs in by itself (development). */
  codeFor(siteId: string): Promise<string | null>,
  signInUrl?: string,
  signOut?(): Promise<void>
}

export class PanelError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export async function fetchDescriptor(url: string): Promise<SiteDescriptor> {
  let origin: string;
  try {
    origin = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).origin;
  } catch {
    throw new PanelError(400, "That doesn't look like a URL");
  }
  let response: Response;
  try {
    response = await fetch(`${origin}/.well-known/vibe-cms`);
  } catch {
    throw new PanelError(502, `Couldn't reach ${origin}`);
  }
  if(!response.ok) throw new PanelError(422, `${origin} isn't a vibe-cms site (no /.well-known/vibe-cms)`);
  const descriptor = await response.json() as SiteDescriptor;
  if(descriptor.protocol !== 1 || !descriptor.id || !descriptor.admin) throw new PanelError(422, "Unsupported site descriptor");
  return descriptor;
}

const STORAGE_KEY = "vibe-panel:sites";

/** The local panel (`vibe-cms admin`): no identity provider, sites in localStorage. */
export function localBackend(): PanelBackend {
  function read(): PanelSite[] {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as PanelSite[];
    } catch {
      return [];
    }
  }
  function write(sites: PanelSite[]) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
  }
  return {
    mode: "local",
    me: async () => ({ name: "Local developer" }),
    sites: async () => read(),
    async addSite(url) {
      const descriptor = await fetchDescriptor(url);
      const site: PanelSite = {
        id: descriptor.id,
        url: new URL(descriptor.admin).origin,
        name: descriptor.name,
        admin: descriptor.admin,
        favorite: false
      };
      write([...read().filter(s => s.id !== site.id), site]);
      return site;
    },
    async removeSite(id) {
      write(read().filter(s => s.id !== id));
    },
    async setFavorite(id, favorite) {
      write(read().map(s => (s.id === id ? { ...s, favorite } : s)));
    },
    codeFor: async () => null
  };
}

/** The hosted panel: everything goes through the panel's own backend. */
export function hostedBackend(base = ""): PanelBackend {
  async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    let body = init.body;
    if(init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const response = await fetch(`${base}/api${path}`, { ...init, headers, body, credentials: "same-origin" });
    const data = response.status === 204 ? null : await response.json().catch(() => null) as { error?: string } | null;
    if(!response.ok) throw new PanelError(response.status, data?.error ?? response.statusText);
    return data as T;
  }
  return {
    mode: "hosted",
    async me() {
      try {
        return await api<PanelUser>("/me");
      } catch (error) {
        if(error instanceof PanelError && error.status === 401) return null;
        throw error;
      }
    },
    sites: () => api("/sites"),
    addSite: url => api("/sites", { method: "POST", json: { url } }),
    removeSite: async id => {
      await api(`/sites/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
    setFavorite: async (id, favorite) => {
      await api(`/sites/${encodeURIComponent(id)}/favorite`, { method: favorite ? "PUT" : "DELETE" });
    },
    codeFor: async id => (await api<{ code: string }>(`/sites/${encodeURIComponent(id)}/code`, { method: "POST" })).code,
    signInUrl: `${base}/auth/login`,
    signOut: async () => {
      await fetch(`${base}/auth/logout`, { method: "POST", credentials: "same-origin" });
    }
  };
}
