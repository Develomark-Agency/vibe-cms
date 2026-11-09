/**
 * Which environment a deployment is: `VIBE_ENV`, a deploy setting like `VIBE_ORG`, never site config,
 * because the same code runs as production, staging and on a laptop. Unset, a deployed site is
 * `production` and a development server (`dev`) is `development`.
 *
 * Anything but production asks search engines to stay away: every response the wrapped Worker
 * sends gets `X-Robots-Tag: noindex, nofollow`, and `/robots.txt` disallows everything.
 */

export interface EnvironmentEnv {
  /** `production`, or any other name (`staging`, `preview`, …) for a deployment search engines should skip. */
  VIBE_ENV?: string
}

export const PRODUCTION = "production";
export const NOINDEX = "noindex, nofollow";
export const ROBOTS_DISALLOW = "User-agent: *\nDisallow: /\n";

/** The deployment's environment name, lowercased. */
export function environmentOf(env: EnvironmentEnv | undefined, dev: boolean): string {
  const name = env?.VIBE_ENV?.trim().toLowerCase();
  if(!name) return dev ? "development" : PRODUCTION;
  if(!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`vibe-cms: VIBE_ENV "${env!.VIBE_ENV}" isn't a name like production or staging`);
  return name;
}

/** `/robots.txt` for a deployment that isn't production: nothing may be crawled, whatever the site's own file says. */
export function robotsResponse(): Response {
  return new Response(ROBOTS_DISALLOW, { headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": NOINDEX } });
}

/** The response with `X-Robots-Tag` set. Protocol switches (WebSockets) pass through untouched. */
export function withNoindex(response: Response): Response {
  if(response.status === 101) return response;
  const copy = new Response(response.body, response);
  copy.headers.set("x-robots-tag", NOINDEX);
  return copy;
}
