/**
 * Organizations: the stable name a site and its hub agree on.
 *
 * A site is deployed with `VIBE_ORG=my-org.com`. It finds its hub through a DNS TXT record,
 * `_vibe-hub.my-org.com "https://admin.my-org.com"`, and accepts tokens whose `iss` is the org.
 * The hub's address can then change by editing one DNS record. An org may also be given as a
 * URL (`VIBE_ORG=https://admin.my-org.com`): the hub is that address, with no DNS lookup, which
 * suits development and setups without a domain of their own.
 */

/** How long a site waits before accepting a move to another org, unless `VIBE_ORG_MOVE_DELAY` says otherwise. */
export const ORG_MOVE_DELAY_SECONDS = 72 * 3600;

/** The `scope` of a hub token that moves a site to another org. */
export const ORG_MOVE_SCOPE = "org-move";

/** A move token lives this long: long enough for the hub to deliver it. */
export const ORG_MOVE_TOKEN_TTL = "15m";

/** `My-Org.com.` → `my-org.com`; a URL → its origin. Null when it's neither. */
export function normalizeOrg(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if(!trimmed) return null;
  if(/^https?:\/\//i.test(trimmed)) {
    if(!URL.canParse(trimmed)) return null;
    return new URL(trimmed).origin;
  }
  const domain = trimmed.toLowerCase().replace(/\.$/, "");
  if(!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(domain)) return null;
  return domain;
}

/** The DNS name that holds an org's hub address. */
export function hubRecordName(org: string): string {
  return `_vibe-hub.${org}`;
}

export class OrgLookupError extends Error {}

interface DohAnswer {
  type: number,
  data: string,
  TTL?: number
}

const cache = new Map<string, { hub: string, until: number }>();

/** Where DNS-over-HTTPS lookups go. Replaceable for tests. */
export const dns = { endpoint: "https://cloudflare-dns.com/dns-query" };

/**
 * The hub's address for an org: the org itself when it's a URL, else its `_vibe-hub` TXT record,
 * looked up over HTTPS and cached for the record's TTL (one minute to an hour).
 */
export async function resolveHub(org: string, options: { fresh?: boolean } = {}): Promise<string> {
  if(/^https?:\/\//.test(org)) return org;
  const cached = cache.get(org);
  if(cached && cached.until > Date.now() && !options.fresh) return cached.hub;
  const name = hubRecordName(org);
  const url = `${dns.endpoint}?name=${encodeURIComponent(name)}&type=TXT`;
  const response = await fetch(url, { headers: { accept: "application/dns-json" } }).catch(() => null);
  if(!response?.ok) throw new OrgLookupError(`Couldn't look up ${name} (${response ? response.status : "network error"})`);
  const body = await response.json().catch(() => ({})) as { Status?: number, Answer?: DohAnswer[] };
  const records = (body.Answer ?? []).filter(answer => answer.type === 16).map(answer => ({ text: txtValue(answer.data), ttl: answer.TTL ?? 300 }));
  const hubs = records.filter(record => record.text.startsWith("https://") && URL.canParse(record.text));
  if(hubs.length === 0) throw new OrgLookupError(`${name} has no TXT record with the hub's https:// address`);
  if(new Set(hubs.map(record => new URL(record.text).origin)).size > 1) throw new OrgLookupError(`${name} has more than one hub address`);
  const hub = new URL(hubs[0]!.text).origin;
  const ttl = Math.min(3600, Math.max(60, hubs[0]!.ttl));
  cache.set(org, { hub, until: Date.now() + ttl * 1000 });
  return hub;
}

/** TXT data comes quoted, and long values in several quoted pieces: `"https://a" "dmin.example.com"`. */
function txtValue(data: string): string {
  const pieces = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]!.replace(/\\(.)/g, "$1"));
  return (pieces.length ? pieces.join("") : data).trim();
}

/** Forgets cached lookups, for tests. */
export function clearOrgCache() {
  cache.clear();
}

/** What a site reports about its org in its descriptor and to its editor. */
export interface OrgStatus {
  /** The org the site trusts now; null for a site without one. */
  org: string | null,
  /** The org's hub, when it could be looked up. */
  hub: string | null,
  /** A move to another org that takes effect at `effectiveAt` (milliseconds) unless cancelled. */
  move: { to: string, requestedAt: number, effectiveAt: number } | null
}
