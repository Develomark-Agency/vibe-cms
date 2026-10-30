import { toast } from "sonner";
import type { SerializedConfig } from "../../config.ts";
import { Result } from "better-result";
import { createThrowingActionClient, encodeInput } from "../../actions/client.ts";
import type { CoreActions } from "../../actions/core.ts";
import type { ActionErrorTag } from "../../actions/errors.ts";
import { createQueryClient } from "../../query/index.ts";
import type { SiteSettings } from "../../handler/engine.ts";
import type { Session } from "../../server/index.ts";
import type { AdminClient } from "../index.ts";

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
    readonly details?: any,
    /** The action error's tag, e.g. `Conflict`, when the server sent one. */
    readonly tag?: ActionErrorTag
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
    const failure = data as { error?: string, details?: unknown, tag?: ActionErrorTag } | string;
    throw typeof failure === "string"
      ? new ApiError(response.status, response.statusText)
      : new ApiError(response.status, failure?.error ?? response.statusText, failure?.details, failure?.tag);
  }
  return data as T;
}

/** Raw bytes from the editor API, with the same credentials as `request`, for previews `<img src>` can't authenticate. */
export async function requestBlob(prefix: string, path: string): Promise<Blob> {
  const headers = new Headers();
  if(token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${prefix}/api${path}`, { headers, credentials: "same-origin" });
  if(!response.ok) throw new ApiError(response.status, `Couldn't load the file (${response.status})`);
  return response.blob();
}

export function createAdminClient(prefix: string, types: string[], navigate: (path: string) => void): AdminClient {
  function api<T>(path: string, init?: RequestInit & { json?: unknown }) {
    return request<T>(prefix, path, init);
  }
  // `request` throws `ApiError` on failure, so the editor catches rather than matching results.
  const actions = createThrowingActionClient<CoreActions>(async (name, input) => {
    const { body, contentType } = encodeInput(input);
    return Result.ok(await api(`/actions/${name}`, { method: "POST", body, headers: contentType ? { "content-type": contentType } : {} }));
  });
  const plugins = new Proxy({} as AdminClient["plugins"], {
    get: (_, name: string) => new Proxy({}, {
      get: (__, route: string) => (body?: unknown) => request(prefix, `/plugins/${name}/${route}`, { method: "POST", json: body ?? {} })
    })
  });
  return {
    api,
    actions,
    query: createQueryClient(async queries => (await api<{ results: unknown[] }>("/query", { method: "POST", json: { queries } })).results),
    upload: (file, options = {}) => actions.assets.upload({ file, ...options }),
    assets: {
      list: (options = {}) => actions.assets.list(options),
      get: id => actions.assets.get({ id })
    },
    documents: {
      list: (type, options = {}) => actions.documents.list({ type, ...options })
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
