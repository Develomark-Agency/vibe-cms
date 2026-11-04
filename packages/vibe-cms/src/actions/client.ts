import { ORPCError } from "@orpc/client";
import type { AnyRouter, RouterClient } from "@orpc/server";
import { errorFromBody } from "./errors.ts";

/**
 * `client.documents.list(input)` for every action in a router, resolving to its output and rejecting
 * with an `ORPCError` (`code`, `message`, `data`) on failure.
 */
export type ActionClient<R extends AnyRouter> = RouterClient<R>;

/** Sends one action by its dotted name (`documents.list`) and resolves to its output: `httpCaller` over HTTP, or your own transport. Rejects with an `ORPCError`. */
export type ActionCaller = (name: string, input: unknown) => Promise<unknown>;

function proxy(call: ActionCaller): any {
  return new Proxy({}, {
    get: (_, group) => typeof group !== "string" ? undefined : new Proxy({}, {
      get: (__, verb) => typeof verb !== "string" ? undefined : (input?: unknown) => call(`${group}.${verb}`, input ?? {})
    })
  });
}

/**
 * A typed client for actions: `createActionClient<CoreActions>(httpCaller({ url, token }))`, then
 * `await client.documents.create({ … })`. See `vibe-cms docs queries` (Writing).
 */
export function createActionClient<R extends AnyRouter>(call: ActionCaller): ActionClient<R> {
  return proxy(call);
}

export interface HttpCallerOptions {
  /** The site's origin, e.g. `http://localhost:1337`. */
  url: string,
  /** The CMS prefix, if the site changed it. */
  prefix?: string,
  /** A site session token. Development sites give one to `POST /_vibe/api/session { dev: true }`. */
  token?: string,
  fetch?: typeof fetch,
  credentials?: RequestCredentials
}

/** Calls actions over `POST /_vibe/api/actions/<name>`: JSON, or multipart when the input holds a `File`. */
export function httpCaller(options: HttpCallerOptions): ActionCaller {
  const base = `${options.url.replace(/\/$/, "")}${options.prefix ?? "/_vibe"}/api/actions/`;
  const doFetch = options.fetch ?? fetch;
  return async (name, input) => {
    const headers = new Headers();
    if(options.token) headers.set("authorization", `Bearer ${options.token}`);
    const { body: payload, contentType } = encodeInput(input);
    if(contentType) headers.set("content-type", contentType);
    const response = await doFetch(`${base}${name}`, { method: "POST", headers, body: payload, credentials: options.credentials });
    const body = response.headers.get("content-type")?.includes("json") ? await response.json() : { error: await response.text() };
    if(response.ok) return body;
    throw errorFromBody(body as { code?: string, error?: string, data?: unknown, defined?: boolean }, response.status);
  };
}

/** An action's input as a request body: JSON, or multipart when it holds a file. */
export function encodeInput(input: unknown): { body: BodyInit, contentType?: string } {
  const entries = typeof input === "object" && input !== null ? Object.entries(input) : [];
  if(!entries.some(([, value]) => value instanceof Blob)) return { body: JSON.stringify(input ?? {}), contentType: "application/json" };
  const form = new FormData();
  for(const [key, value] of entries) {
    if(value === undefined) continue;
    if(value instanceof Blob) form.set(key, value);
    else if(Array.isArray(value)) value.forEach(item => form.append(key, typeof item === "string" ? item : JSON.stringify(item)));
    else form.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return { body: form };
}

export { ORPCError };
