import type { AnyConfig } from "../config.ts";
import { createQueryClient, serializeQuery, type QueryClient, type SerializedQuery } from "../query/index.ts";

export interface ClientOptions {
  /** The site's origin, e.g. `https://my-client-site.com`. */
  url: string,
  /** Site session token, needed for `drafts: true`. Published reads are public. */
  token?: string,
  /** The CMS prefix, if the site changed it. */
  prefix?: string,
  fetch?: typeof fetch
}

export class ClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

/** Content access over HTTP, for browsers, apps and other services. */
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
