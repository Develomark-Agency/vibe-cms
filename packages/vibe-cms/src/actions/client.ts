import { Result } from "better-result";
import type { ActionInput, ActionOutput, AnyAction } from "./define.ts";
import { errorFromJson, type ActionError } from "./errors.ts";

type Group<K> = K extends `${infer G}.${string}` ? G : never;

type Args<A extends AnyAction> = {} extends ActionInput<A> ? [input?: ActionInput<A>] : [input: ActionInput<A>];

/** `client.documents.list(input)` for every `documents.list`-style action, resolving to a `Result`. */
export type ActionClient<A extends Record<string, AnyAction>> = {
  [G in Group<keyof A & string>]: {
    [K in keyof A & `${G}.${string}` as K extends `${G}.${infer V}` ? V : never]: (...args: Args<A[K]>) => Promise<Result<ActionOutput<A[K]>, ActionError>>
  }
};

/** The same, for callers that would rather catch: failures reject with the tagged error. */
export type ThrowingActionClient<A extends Record<string, AnyAction>> = {
  [G in Group<keyof A & string>]: {
    [K in keyof A & `${G}.${string}` as K extends `${G}.${infer V}` ? V : never]: (...args: Args<A[K]>) => Promise<ActionOutput<A[K]>>
  }
};

/** Sends one action by name and resolves to its `Result`: `httpCaller` over HTTP, or your own transport. */
export type ActionCaller = (name: string, input: unknown) => Promise<Result<unknown, ActionError>>;

function proxy(call: (name: string, input: unknown) => Promise<unknown>): any {
  return new Proxy({}, {
    get: (_, group) => typeof group !== "string" ? undefined : new Proxy({}, {
      get: (__, verb) => typeof verb !== "string" ? undefined : (input?: unknown) => call(`${group}.${verb}`, input ?? {})
    })
  });
}

/**
 * A typed client for actions: `createActionClient<CoreActions>(httpCaller({ url, token }))`, then
 * `client.documents.create({ … })` resolves to a `Result`. See `vibe-cms docs queries` (Writing).
 */
export function createActionClient<A extends Record<string, AnyAction>>(call: ActionCaller): ActionClient<A> {
  return proxy(call);
}

/** Like `createActionClient`, but failures reject with the tagged error (`_tag`, `message`, `details`). */
export function createThrowingActionClient<A extends Record<string, AnyAction>>(call: ActionCaller): ThrowingActionClient<A> {
  return proxy(async (name, input) => {
    const result = await call(name, input);
    if(result.isErr()) throw result.error;
    return result.value;
  });
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
    return response.ok ? Result.ok(body) : Result.err(errorFromJson(body as { tag?: string, error?: string, details?: unknown }, response.status));
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
