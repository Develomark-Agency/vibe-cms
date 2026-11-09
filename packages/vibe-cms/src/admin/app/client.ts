import type { SiteWarning } from "../../handler/images.ts";
import { toast } from "sonner";
import { hc } from "hono/client";
import type { SerializedConfig } from "../../config.ts";
import { ORPCError } from "@orpc/client";
import { createActionClient, encodeInput } from "../../actions/client.ts";
import type { CoreActions } from "../../actions/core.ts";
import { codeForStatus } from "../../actions/errors.ts";
import { createQueryClient } from "../../query/index.ts";
import type { SiteSettings } from "../../handler/engine.ts";
import type { SiteApi } from "../../handler/router.ts";
import type { Session } from "../../server/index.ts";
import type { AdminClient } from "../index.ts";
import { notifyPreview } from "./preview.ts";

export interface SiteInfo extends SerializedConfig {
  prefix: string,
  dev: boolean,
  /** The hub of the org the site trusts (`VIBE_ORG`), as its DNS record names it. */
  hub: string | null,
  /** How the site signs people in: through its org's hub, its own identity provider, or passkeys. */
  signIn: "hub" | "oidc" | "passkey",
  site: {
    id: string,
    name: string,
    admin: string,
    org: string | null,
    /** A pending move to another org; it takes effect at `effectiveAt` unless someone cancels it. */
    orgMove: { to: string, requestedAt: number, effectiveAt: number } | null,
    /** Setup problems a developer should fix, e.g. image optimization failing. */
    warnings: SiteWarning[]
  },
  /** As of page load; the editor keeps the live copy under the "site" query. */
  settings: SiteSettings
}

export interface Permissions {
  types: Record<string, { read: boolean, write: boolean, publish: boolean, delete: boolean }>,
  media: { read: boolean, write: boolean, delete: boolean },
  locales: string[],
  /** May change the site's name, accent and icon. */
  site: boolean,
  /** May invite people and change their roles (sites that sign people in themselves). */
  users: boolean,
  /** May edit the site's roles: owners and roles with `all`. */
  roles: boolean,
  /** May see everyone's activity (`viewActivity`); everyone sees their own. Missing from older sites. */
  activity?: boolean
}

export interface SessionState {
  user: Session,
  permissions: Permissions,
  /** In-memory token (embedded mode). Full-page sessions use an httpOnly cookie instead. */
  token?: string,
  expiresAt: number
}

/** A failed request: an `ORPCError` (`code`, `data`) that also knows the HTTP `status`. `details` is `data`. */
export class ApiError extends ORPCError<string, any> {
  constructor(
    readonly status: number,
    message: string,
    details?: any,
    /** The action error's code, e.g. `CONFLICT`, when the server sent one. */
    code?: string,
    /** Whether the action declared this error (oRPC's `isDefinedError`). */
    defined = false
  ) {
    super(code ?? codeForStatus(status), { message, data: details });
    // oRPC types `defined` as read-only; it builds errors from JSON the same way.
    (this as { defined: boolean }).defined = defined;
  }

  get details(): any {
    return this.data;
  }

  // `ORPCError` matches any of its errors; this matches only requests that failed.
  static override [Symbol.hasInstance](instance: unknown): boolean {
    return Function.prototype[Symbol.hasInstance].call(this, instance);
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
  headers.set("x-vibe-via", "ui");
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
    const failure = data as { error?: string, data?: unknown, code?: string, defined?: boolean } | string;
    throw typeof failure === "string"
      ? new ApiError(response.status, response.statusText)
      : new ApiError(response.status, failure?.error ?? response.statusText, failure?.data, failure?.code, failure?.defined);
  }
  return data as T;
}

/** The site's own routes, typed by the server's (`SiteApi`). Carries the session token and reports expiry like `request`. */
function createSiteApi(prefix: string) {
  return hc<SiteApi>(`${location.origin}${prefix}/api`, {
    headers: (): Record<string, string> => ({ "x-vibe-via": "ui", ...(token ? { authorization: `Bearer ${token}` } : {}) }),
    init: { credentials: "same-origin" },
    async fetch(input: RequestInfo | URL, init?: RequestInit) {
      const response = await fetch(input, init);
      const { pathname } = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if(response.status === 401 && !pathname.startsWith(`${prefix}/api/session`)) onUnauthorized?.();
      return response;
    }
  });
}

const siteApis = new Map<string, ReturnType<typeof createSiteApi>>();

/** `siteApi(prefix).users[":id"].$patch({ param: { id }, json: { roles } })`, then `read(...)`. */
export function siteApi(prefix: string) {
  let found = siteApis.get(prefix);
  if(!found) siteApis.set(prefix, found = createSiteApi(prefix));
  return found;
}

interface Reply<T> {
  ok: boolean,
  status: number,
  statusText: string,
  headers: Headers,
  json(): Promise<T>,
  text(): Promise<string>
}

/** A reply's JSON, or an `ApiError` carrying the server's message, code and data. */
export async function read<T>(reply: Reply<T>): Promise<T> {
  if(reply.ok) return reply.json();
  const failure = reply.headers.get("content-type")?.includes("json")
    ? await reply.json().catch(() => null) as { error?: string, data?: unknown, code?: string, defined?: boolean } | null
    : null;
  throw new ApiError(reply.status, failure?.error ?? reply.statusText, failure?.data, failure?.code, failure?.defined);
}

/** Raw bytes from the editor API, with the same credentials as `request`, for previews `<img src>` can't authenticate. */
export async function requestBlob(prefix: string, path: string): Promise<Blob> {
  const headers = new Headers();
  if(token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${prefix}/api${path}`, { headers, credentials: "same-origin" });
  if(!response.ok) throw new ApiError(response.status, `Couldn't load the file (${response.status})`);
  return response.blob();
}

/** The read-only core actions (`readOnly` in their annotations), by name, so the editor doesn't load their definitions. */
const READ_ONLY_ACTION = /\.(list|get|references|versions?)$/;

export function createAdminClient(prefix: string, types: string[], navigate: (path: string) => void): AdminClient {
  function api<T>(path: string, init?: RequestInit & { json?: unknown }) {
    return request<T>(prefix, path, init);
  }
  // `request` throws `ApiError` on failure, so the editor catches rather than matching results.
  const actions = createActionClient<CoreActions>(async (name, input) => {
    const { body, contentType } = encodeInput(input);
    const result = await api(`/actions/${name}`, { method: "POST", body, headers: contentType ? { "content-type": contentType } : {} });
    // Anything that changed content (a save, not only a publish) refreshes open previews.
    if(!READ_ONLY_ACTION.test(name)) notifyPreview();
    return result;
  });
  const plugins = new Proxy({} as AdminClient["plugins"], {
    get: (_, name: string) => new Proxy({}, {
      get: (__, route: string) => (body?: unknown) => request(prefix, `/plugins/${name}/${route}`, { method: "POST", json: body ?? {} })
    })
  });
  return {
    api,
    actions,
    query: createQueryClient(async queries => (await read(await siteApi(prefix).query.$post({ json: { queries } }))).results),
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
