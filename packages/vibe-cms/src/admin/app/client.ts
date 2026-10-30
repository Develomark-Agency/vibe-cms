import { toast } from "sonner";
import type { SerializedConfig } from "../../config.ts";
import { createQueryClient } from "../../query/index.ts";
import type { SiteSettings } from "../../handler/engine.ts";
import type { Session } from "../../server/index.ts";
import type { AdminClient, Asset } from "../index.ts";

export interface SiteInfo extends SerializedConfig {
  prefix: string,
  dev: boolean,
  auth: { issuer: string } | null,
  site: { id: string, name: string, admin: string },
  /** As of page load; the editor keeps the live copy under the "site" query. */
  settings: SiteSettings
}

export interface Permissions {
  types: Record<string, { read: boolean, write: boolean, publish: boolean, delete: boolean }>,
  media: { read: boolean, write: boolean, delete: boolean },
  locales: string[],
  /** May change the site's name, accent and icon. */
  site: boolean
}

export interface SessionState {
  user: Session,
  permissions: Permissions,
  /** In-memory token (embedded mode). Full-page sessions use an httpOnly cookie instead. */
  token?: string,
  expiresAt: number
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: any
  ) {
    super(message);
  }
}

/** `/_vibe/admin/...` → `/_vibe`. Works whatever prefix the site configured. */
export function detectPrefix(): string {
  const match = /^(.*)\/admin(\/|$)/.exec(location.pathname);
  return match?.[1] ?? "/_vibe";
}

let token: string | undefined;
let onUnauthorized: (() => void) | undefined;

export function setToken(next: string | undefined) {
  token = next;
}

export function setUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}

export async function request<T>(prefix: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if(token) headers.set("authorization", `Bearer ${token}`);
  let body = init.body;
  if(init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const url = path.startsWith("/plugins/") ? `${prefix}${path}` : `${prefix}/api${path}`;
  const response = await fetch(url, { ...init, headers, body, credentials: "same-origin" });
  const data = response.headers.get("content-type")?.includes("json") ? await response.json() : await response.text();
  if(!response.ok) {
    if(response.status === 401 && !path.startsWith("/session")) onUnauthorized?.();
    throw new ApiError(response.status, (data as { error?: string })?.error ?? response.statusText, (data as { details?: unknown })?.details);
  }
  return data as T;
}

export function createAdminClient(prefix: string, types: string[], navigate: (path: string) => void): AdminClient {
  function api<T>(path: string, init?: RequestInit & { json?: unknown }) {
    return request<T>(prefix, path, init);
  }
  const plugins = new Proxy({} as AdminClient["plugins"], {
    get: (_, name: string) => new Proxy({}, {
      get: (__, route: string) => (body?: unknown) => request(prefix, `/plugins/${name}/${route}`, { method: "POST", json: body ?? {} })
    })
  });
  return {
    api,
    query: createQueryClient(async queries => (await api<{ results: unknown[] }>("/query", { method: "POST", json: { queries } })).results),
    upload(file, options = {}) {
      const form = new FormData();
      form.set("file", file);
      for(const [key, value] of Object.entries(options)) if(value) form.set(key, value);
      return api<Asset>("/assets", { method: "POST", body: form });
    },
    assets: {
      list(options = {}) {
        const params = new URLSearchParams();
        for(const [key, value] of Object.entries(options)) {
          if(Array.isArray(value)) value.forEach(v => params.append(key, v));
          else if(value !== undefined) params.set(key, String(value));
        }
        return api(`/assets?${params}`);
      },
      get: id => api(`/assets/${id}`)
    },
    documents: {
      list(type, options = {}) {
        const params = new URLSearchParams();
        for(const [key, value] of Object.entries(options)) if(value !== undefined) params.set(key, String(value));
        return api(`/documents/${type}?${params}`);
      }
    },
    plugins,
    mediaUrl: id => `${prefix}/media/${id}`,
    types,
    navigate,
    toast(message, options = {}) {
      if(options.type === "error") toast.error(message);
      else if(options.type === "success") toast.success(message);
      else toast(message);
    }
  };
}
