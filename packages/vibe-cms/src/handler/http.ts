import type { Context, Next } from "hono";
import { validator } from "hono/validator";
import { HttpError } from "../config.ts";
import type { Session } from "../server/index.ts";
import { errorBody, statusForCode, type ActionError } from "../actions/errors.ts";
import { grantSession } from "./oauth.ts";
import { sessionFromHubToken, verifySession } from "./auth.ts";
import type { Engine, EngineState } from "./engine.ts";
import type { ExecutionContext, Fetcher } from "./platform.ts";

/** What the router is handed with each request, as Hono's `env`. */
export interface ApiContext {
  state: EngineState,
  dev: boolean,
  assets: Fetcher | undefined,
  ctx: ExecutionContext
}

/** `session` and `engine` are set once the router has worked out who is asking. */
export type SiteEnv = {
  Bindings: ApiContext,
  Variables: { session: Session | null, engine: Engine }
};

export type SiteContext = Context<SiteEnv>;

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", headers.get("cache-control") ?? "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") ?? "";
  for(const part of header.split(/;\s*/)) {
    const [key, ...rest] = part.split("=");
    if(key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/** A site session token, or a token the hub signed for this site, as `Authorization: Bearer`. */
export async function readSession(request: Request, api: ApiContext): Promise<Session | null> {
  const header = request.headers.get("authorization");
  if(!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  return await verifySession(api.state.db, token, api.state.siteId)
    ?? await grantSession(api.state, token)
    ?? await sessionFromHubToken(api.state, token);
}

export async function body<T>(request: Request): Promise<T> {
  try {
    return await request.json() as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-allow-methods": "GET, POST, OPTIONS"
};

/** Lets any origin call the route, as the public query API and signed backup links are. */
export async function cors(c: Context, next: Next) {
  if(c.req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  await next();
  for(const [name, value] of Object.entries(CORS_HEADERS)) c.header(name, value);
}

export function redirect(url: URL, path: string, cookie: string): Response {
  return new Response(null, { status: 302, headers: { location: new URL(path, url.origin).href, "set-cookie": cookie, "cache-control": "no-store" } });
}

export function errorResponse(error: ActionError): Response {
  return json(errorBody(error), { status: statusForCode(error.code) });
}

export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if(!text.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "Expected a JSON object body");
}

export function formValues(form: FormData): Record<string, string | string[] | File> {
  const out: Record<string, string | string[] | File> = {};
  for(const key of new Set(form.keys())) {
    const values = form.getAll(key);
    out[key] = values.length > 1 ? values.filter(v => typeof v === "string") : values[0]!;
  }
  return out;
}

export function queryValues(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for(const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length > 1 ? values : values[0]!;
  }
  return query;
}

/**
 * A JSON object body, typed as `T` for the route (and for `hc` clients of it). The route's own checks
 * decide what's valid; this only insists on an object. Bodies sent without a JSON content type still parse.
 */
export function jsonInput<T extends object>() {
  return validator("json", async (value, c): Promise<T> => (await jsonObject(value, c)) as T);
}

/** A parsed JSON body that must be an object; a body sent without a JSON content type is parsed here. */
export async function jsonObject(value: unknown, c: Context): Promise<Record<string, unknown>> {
  let input = value;
  if(!(c.req.header("content-type") ?? "").includes("json")) {
    const text = await c.req.text();
    try {
      input = text.trim() ? JSON.parse(text) : {};
    } catch {
      throw new HttpError(400, "Expected a JSON body");
    }
  }
  if(typeof input !== "object" || input === null || Array.isArray(input)) throw new HttpError(400, "Expected a JSON body");
  return input as Record<string, unknown>;
}
