/** Answers a request for one of the site's own pages or files, in-process where possible. */
export type SiteFetch = (request: Request) => Promise<Response>;

const TIMEOUT = 3000;

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT))]);
}

/** `<link rel="icon" href="…">` and friends, best first. */
function iconLinks(html: string): string[] {
  const found: Array<{ href: string, rank: number }> = [];
  for(const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = /\brel\s*=\s*["']?([^"'>]+)/i.exec(tag)?.[1]?.toLowerCase().split(/\s+/) ?? [];
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if(!value) continue;
    // A square touch icon looks best as an app mark; a plain favicon is next.
    const rank = rel.includes("apple-touch-icon") ? 0 : rel.includes("icon") ? 1 : -1;
    if(rank >= 0) found.push({ href: value.replace(/&amp;/g, "&"), rank });
  }
  return found.sort((a, b) => a.rank - b.rank).map(f => f.href);
}

async function isImage(fetchSite: SiteFetch, url: URL): Promise<boolean> {
  try {
    const response = await withTimeout(fetchSite(new Request(url.href)));
    await response.body?.cancel();
    return response.ok && (response.headers.get("content-type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

/**
 * The site's own favicon: the best `<link rel="icon">` on its home page, else `/favicon.ico`.
 * Same-origin icons come back root-relative; null when there's none.
 */
export async function detectFavicon(origin: string, fetchSite: SiteFetch): Promise<string | null> {
  const home = new URL("/", origin);
  let candidates: string[] = [];
  try {
    const response = await withTimeout(fetchSite(new Request(home.href, { headers: { accept: "text/html" } })));
    if(response.ok && (response.headers.get("content-type") ?? "").includes("html")) candidates = iconLinks(await response.text());
    else await response.body?.cancel();
  } catch {
    // An unreachable home page still leaves /favicon.ico.
  }
  for(const href of [...candidates, "/favicon.ico"]) {
    if(href.startsWith("data:image/")) return href;
    let url: URL;
    try {
      url = new URL(href, home);
    } catch {
      continue;
    }
    if(url.protocol !== "https:" && url.protocol !== "http:") continue;
    if(url.origin !== home.origin) return url.href;
    if(await isImage(fetchSite, url)) return url.pathname + url.search;
  }
  return null;
}
