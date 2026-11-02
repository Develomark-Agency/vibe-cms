import type { AnyConfig } from "../config.ts";
import { createQueryClient, serializeQuery, type QueryClient, type SerializedQuery } from "../query/index.ts";

/** Where `createClient` sends queries, and with which credentials. */
export interface ClientOptions {
  /** The site's origin, e.g. `https://my-client-site.com`. */
  url: string,
  /** Site session token, needed for `drafts: true`. Published reads are public. */
  token?: string,
  /** The CMS prefix, if the site changed it. */
  prefix?: string,
  fetch?: typeof fetch
}

/** A failed query request: the HTTP status, the server's message, and its details (such as validation issues). */
export class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

/**
 * Typed content access over HTTP, for browsers, apps and other services: the same queries as
 * `vibe.client(env)`, sent to `POST /_vibe/api/query`. Published reads are public; `drafts: true` needs a token.
 *
 * See `vibe-cms docs http-client`.
 */
export function createClient<C extends AnyConfig>(options: ClientOptions): QueryClient<C> {
  const endpoint = `${options.url.replace(/\/$/, "")}${options.prefix ?? "/_vibe"}/api/query`;
  const doFetch = options.fetch ?? fetch;
  return createQueryClient<C>(async (queries: SerializedQuery[]) => {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
      },
      body: JSON.stringify({ queries: queries.map(serializeQuery) })
    });
    const data = await response.json() as { results?: unknown[], error?: string, details?: unknown };
    if(!response.ok || !data.results) throw new ClientError(response.status, data.error ?? response.statusText, data.details);
    return data.results;
  });
}
