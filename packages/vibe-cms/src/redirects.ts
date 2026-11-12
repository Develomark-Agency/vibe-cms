/**
 * Redirects as pure functions: path normalization, matching, and the checks run before a rule is saved.
 * No database and no Worker APIs, so the handler, the engine and the editor's CSV import share it.
 * See `vibe-cms docs redirects`.
 */

export const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number];
export type RedirectSource = "manual" | "slug-change" | "trash";

/** What matching needs of a rule. */
export interface MatchRule {
  id: string,
  from: string,
  to: string,
  status: number,
  keepQuery: boolean
}

/** Longest chain a visitor may be sent through while checking a rule for loops. */
const MAX_HOPS = 10;

/**
 * A path as rules compare it: percent-escapes in upper case, `//` collapsed, no trailing slash (except
 * the root). Case of letters is kept: `/About` and `/about` are different paths.
 */
export function normalizePath(path: string): string {
  let out = path.replace(/%[0-9a-f]{2}/gi, escape => escape.toUpperCase()).replace(/\/{2,}/g, "/");
  if(out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out || "/";
}

export function isWildcard(path: string): boolean {
  return path.endsWith("*");
}

function isAbsolute(target: string): boolean {
  return /^https?:\/\//i.test(target);
}

export interface RuleInput {
  from: string,
  to: string,
  status?: number,
  keepQuery?: boolean
}

export interface CheckedRule {
  from: string,
  to: string,
  status: RedirectStatus,
  keepQuery: boolean
}

/**
 * Normalizes and validates one rule on its own: what each field may be. Throws a readable message.
 * `prefix` is the editor's mount point (`/_vibe`), which can't be redirected.
 */
export function checkRule(input: RuleInput, prefix: string): CheckedRule {
  const from = input.from.trim();
  const to = input.to.trim();
  if(!from.startsWith("/")) throw new RedirectError("“From” has to be a path starting with /");
  if(/[?#\s]/.test(from)) throw new RedirectError("“From” is a path only: no spaces, query or fragment");
  const stars = from.split("*").length - 1;
  if(stars > 1 || (stars === 1 && !from.endsWith("*"))) throw new RedirectError("“From” can have one * and only at the end, like /blog/*");
  let normalized: string;
  if(isWildcard(from)) {
    const body = from.slice(0, -1);
    // `/blog*` would also catch `/blogger`: wildcards come right after a slash.
    if(!body.endsWith("/")) throw new RedirectError("A wildcard goes after a slash, like /blog/*");
    normalized = `${normalizePath(body)}${body === "/" ? "" : "/"}*`;
  } else {
    normalized = normalizePath(from);
  }
  if(normalized === "/*") throw new RedirectError("/* would redirect the whole site");
  const root = prefix.replace(/\/$/, "");
  if(normalized === root || normalized.startsWith(`${root}/`) || (isWildcard(normalized) && `${root}/`.startsWith(normalized.slice(0, -1)))) {
    throw new RedirectError(`${root} is the CMS's own and can't be redirected`);
  }
  if(!to) throw new RedirectError("“To” can't be empty");
  if(/\s/.test(to)) throw new RedirectError("“To” can't contain spaces");
  if(!to.startsWith("/") && !isAbsolute(to)) throw new RedirectError("“To” has to be a path starting with / or a full URL");
  if(isAbsolute(to)) {
    try {
      new URL(to.replace("*", "x"));
    } catch {
      throw new RedirectError("“To” isn't a valid URL");
    }
  }
  const toStars = to.split("*").length - 1;
  if(toStars > 1) throw new RedirectError("“To” can have one * at most");
  if(toStars === 1 && !isWildcard(normalized)) throw new RedirectError("“To” uses *, but “from” has no wildcard to fill it");
  const status = input.status ?? 301;
  if(!REDIRECT_STATUSES.includes(status as RedirectStatus)) throw new RedirectError("Status is 301, 302, 307 or 308");
  const target = isAbsolute(to) ? to : to.startsWith("/") ? (to.includes("?") || to.includes("#") ? to : to === "/" || toStars ? to : normalizePath(to)) : to;
  if(!isWildcard(normalized) && target === normalized) throw new RedirectError("“From” and “to” are the same");
  return { from: normalized, to: target, status: status as RedirectStatus, keepQuery: input.keepQuery ?? true };
}

/** A rule the editor can show the reason for: thrown by the checks, mapped to a 400 by the engine. */
export class RedirectError extends Error {}

/** What a wildcard rule matched and where it sends the visit; `null` when the rule doesn't apply. */
function apply(rule: MatchRule, path: string): string | null {
  if(!isWildcard(rule.from)) return rule.from === path ? rule.to : null;
  const prefix = rule.from.slice(0, -1);
  if(!path.startsWith(prefix) || path.length === prefix.length) return null;
  return rule.to.replace("*", path.slice(prefix.length));
}

/** The rules of a site, ready to match: exact paths in a map, wildcards longest prefix first. */
export class RedirectIndex {
  private readonly exact = new Map<string, MatchRule>();
  private readonly wild: Array<{ prefix: string, rule: MatchRule }> = [];

  constructor(rules: readonly MatchRule[]) {
    for(const rule of rules) {
      if(isWildcard(rule.from)) this.wild.push({ prefix: rule.from.slice(0, -1), rule });
      else this.exact.set(rule.from, rule);
    }
    this.wild.sort((a, b) => b.prefix.length - a.prefix.length);
  }

  get size(): number {
    return this.exact.size + this.wild.length;
  }

  /** The rule for a normalized path: an exact match first, then the longest wildcard prefix. */
  find(path: string): MatchRule | null {
    const exact = this.exact.get(path);
    if(exact) return exact;
    for(const { prefix, rule } of this.wild) {
      if(path.startsWith(prefix) && path.length > prefix.length) return rule;
    }
    return null;
  }
}

export interface Resolved {
  rule: MatchRule,
  /** The `Location` to send: the rule's target with the wildcard filled in and the query kept, if it keeps it. */
  location: string,
  status: number
}

/**
 * What to answer a request for `url` with, or null. A relative target keeps the visitor's trailing-slash
 * style, so a site that uses `/about/` doesn't get a second redirect to add it back.
 */
export function resolveRedirect(index: RedirectIndex, url: URL): Resolved | null {
  const path = normalizePath(url.pathname);
  const rule = index.find(path);
  if(!rule) return null;
  const target = apply(rule, path)!;
  let location = target;
  if(target.startsWith("/") && !target.includes("?") && !target.includes("#") && url.pathname.length > 1 && url.pathname.endsWith("/") && target !== "/" && !target.endsWith("/")) location = `${target}/`;
  if(rule.keepQuery && url.search) location += (location.includes("?") ? "&" : "?") + url.search.slice(1);
  return { rule, location, status: rule.status };
}

/**
 * Whether adding `candidate` to `rules` makes some path loop (`/a` → `/b` → `/a`) or chain on without end
 * (`/a/*` → `/a/b/*`). Wildcards are checked with a sample path under them. Returns the chain that fails.
 */
export function findLoop(rules: readonly MatchRule[], candidate: MatchRule): string[] | null {
  const others = rules.filter(rule => rule.from !== candidate.from && rule.id !== candidate.id);
  const index = new RedirectIndex([...others, candidate]);
  // Every rule the candidate touches starts a chain: the candidate itself, and rules that lead into it.
  const starts = [candidate, ...others.filter(rule => leadsTo(rule, candidate))];
  for(const start of starts) {
    const sample = isWildcard(start.from) ? `${start.from.slice(0, -1)}sample` : start.from;
    let path = sample;
    const seen = [path];
    for(let hop = 0; hop < MAX_HOPS; hop++) {
      const rule = index.find(normalizePath(path));
      if(!rule) break;
      const next = apply(rule, normalizePath(path));
      if(!next || !next.startsWith("/")) break;
      const bare = next.split(/[?#]/)[0]!;
      path = bare;
      if(seen.includes(path)) return [...seen, path];
      seen.push(path);
      if(hop === MAX_HOPS - 1) return seen;
    }
  }
  return null;
}

/** Whether `rule`'s target can land on a path `candidate` matches. */
function leadsTo(rule: MatchRule, candidate: MatchRule): boolean {
  if(!rule.to.startsWith("/")) return false;
  const to = rule.to.split(/[?#]/)[0]!;
  const sample = isWildcard(to) ? to.slice(0, -1) + "sample" : to;
  return new RedirectIndex([candidate]).find(normalizePath(sample)) !== null || isWildcard(rule.to) && candidate.from.startsWith(rule.to.slice(0, -1));
}

/** The paths a `from` covers that a live page at `path` would be hidden by. */
export function covers(from: string, path: string): boolean {
  const normalized = normalizePath(path);
  if(!isWildcard(from)) return from === normalized;
  const prefix = from.slice(0, -1);
  return normalized.startsWith(prefix) && normalized.length > prefix.length;
}

// --- A document's URL -------------------------------------------------------------

/** The slice of a collection's settings that says where its documents live. */
export interface UrlSettings {
  url?: string | ((doc: Record<string, unknown>, context: { id: string, locale: string }) => string | null | undefined),
  preview?: string
}

function fill(template: string, doc: Record<string, unknown>, id: string, locale: string): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if(key === "locale") return locale;
    if(key === "id") return id;
    const value = doc[key];
    return typeof value === "string" || typeof value === "number" ? encodeURIComponent(value).replaceAll("%2F", "/") : "";
  });
}

/**
 * Where a document lives on the site, or null when it has no page. In order: the collection's `url`
 * (a function, or a template like `preview`'s), its `preview` template when that is a site path, and
 * the `path` field `pageSchema()` gives its pages.
 */
export function documentUrl(settings: UrlSettings | undefined, schemaHasPath: boolean, doc: Record<string, unknown> | null, id: string, locale: string): string | null {
  if(!doc) return null;
  let url: string | null | undefined;
  if(typeof settings?.url === "function") url = settings.url(doc, { id, locale });
  else if(typeof settings?.url === "string") url = fill(settings.url, doc, id, locale);
  else if(settings?.preview?.startsWith("/")) url = fill(settings.preview, doc, id, locale);
  else if(schemaHasPath && typeof doc.path === "string") url = doc.path;
  if(!url || !url.startsWith("/") || /[?#]/.test(url)) return null;
  // A template whose placeholder was empty (`/posts/`) isn't a page.
  if(url.length > 1 && url.endsWith("/") && /\{\w+\}\/?$/.test(typeof settings?.url === "string" ? settings.url : settings?.preview ?? "")) return null;
  return normalizePath(url);
}
