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

const VARIABLE = /\{([^{}/]*)\}/g;

/** The variables a path declares or uses, in order: `/hello/{a}/bye/{b}` has `a` and `b`. */
export function variablesOf(path: string): string[] {
  return [...path.matchAll(VARIABLE)].map(match => match[1]!);
}

/** Whether a path has a variable or a wildcard, so more than one request can match it. */
export function isDynamic(path: string): boolean {
  return isWildcard(path) || /\{[^{}/]*\}/.test(path);
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
  const declared = variableProblems(from, to);
  if(declared) throw new RedirectError(declared);
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
      new URL(to.replace("*", "x").replace(VARIABLE, "x"));
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

/** What's wrong with the variables of a rule, or null. A rule without any (the usual one) is never touched. */
function variableProblems(from: string, to: string): string | null {
  if(!/[{}]/.test(from) && !/[{}]/.test(to)) return null;
  const names: string[] = [];
  for(const segment of from.split("/")) {
    if(!/[{}]/.test(segment)) continue;
    const name = /^\{(\w+)\}$/.exec(segment)?.[1];
    if(!name) return `“${segment}” isn't a variable: write a whole segment like {name}, with letters, digits or _`;
    if(names.includes(name)) return `{${name}} is used twice in “from”`;
    names.push(name);
  }
  const rest = to.replace(VARIABLE, "");
  if(/[{}]/.test(rest)) return "“To” has a { or } that isn't a complete {name}";
  for(const name of variablesOf(to)) {
    if(!names.includes(name)) return names.length ? `{${name}} isn't in “from”. Available: ${names.map(n => `{${n}}`).join(", ")}` : `{${name}} isn't in “from”, which has no variables`;
  }
  return null;
}

/** A rule the editor can show the reason for: thrown by the checks, mapped to a 400 by the engine. */
export class RedirectError extends Error {}

/** A rule with `{name}` segments, compiled once: matches a path and fills its target. */
interface Pattern {
  rule: MatchRule,
  names: string[],
  regex: RegExp,
  /** Fixed segments, for ordering: more specific patterns first. */
  literals: number
}

function compile(rule: MatchRule): Pattern {
  const names: string[] = [];
  const wildcard = isWildcard(rule.from);
  const body = wildcard ? rule.from.slice(0, -1) : rule.from;
  const parts = body.split("/").map(segment => {
    const name = /^\{(\w+)\}$/.exec(segment)?.[1];
    if(name) {
      names.push(name);
      return "([^/]+)";
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  const literals = body.split("/").filter(segment => segment && !/^\{\w+\}$/.test(segment)).length;
  return { rule, names, regex: new RegExp(`^${parts.join("/")}${wildcard ? "(.+)" : ""}$`), literals };
}

/** Where a pattern sends a path, or null when it doesn't match. Variables and `*` are filled in as they came in the path. */
function fillPattern(pattern: Pattern, path: string): string | null {
  const match = pattern.regex.exec(path);
  if(!match) return null;
  const values = new Map(pattern.names.map((name, index) => [name, match[index + 1]!]));
  const rest = isWildcard(pattern.rule.from) ? match[pattern.names.length + 1]! : "";
  return pattern.rule.to.replace(VARIABLE, (_, name: string) => values.get(name) ?? "").replace("*", () => rest);
}

/** What a wildcard rule matched and where it sends the visit; `null` when the rule doesn't apply. */
function apply(rule: MatchRule, path: string): string | null {
  if(!isWildcard(rule.from)) return rule.from === path ? rule.to : null;
  const prefix = rule.from.slice(0, -1);
  if(!path.startsWith(prefix) || path.length === prefix.length) return null;
  return rule.to.replace("*", () => path.slice(prefix.length));
}

/** The rules of a site, ready to match: exact paths in a map, wildcards longest prefix first. */
export class RedirectIndex {
  private readonly exact = new Map<string, MatchRule>();
  private readonly wild: Array<{ prefix: string, rule: MatchRule }> = [];
  /** Rules with `{name}` segments. Empty for a site that doesn't use them, which then never looks here. */
  private readonly patterns: Pattern[] = [];

  constructor(rules: readonly MatchRule[]) {
    for(const rule of rules) {
      if(/\{\w+\}/.test(rule.from)) this.patterns.push(compile(rule));
      else if(isWildcard(rule.from)) this.wild.push({ prefix: rule.from.slice(0, -1), rule });
      else this.exact.set(rule.from, rule);
    }
    this.wild.sort((a, b) => b.prefix.length - a.prefix.length);
    // More fixed segments first, a pattern without a wildcard before one with, then the longer.
    this.patterns.sort((a, b) => b.literals - a.literals || Number(isWildcard(a.rule.from)) - Number(isWildcard(b.rule.from)) || b.rule.from.length - a.rule.from.length);
  }

  get size(): number {
    return this.exact.size + this.wild.length + this.patterns.length;
  }

  /** The rule for a normalized path: an exact match first, then patterns with variables, then the longest wildcard prefix. */
  find(path: string): MatchRule | null {
    return this.match(path)?.rule ?? null;
  }

  /** The rule for a path and the target it sends the path to. */
  match(path: string): { rule: MatchRule, target: string } | null {
    const exact = this.exact.get(path);
    if(exact) return { rule: exact, target: exact.to };
    for(const pattern of this.patterns) {
      const target = fillPattern(pattern, path);
      if(target !== null) return { rule: pattern.rule, target };
    }
    for(const { prefix, rule } of this.wild) {
      if(path.startsWith(prefix) && path.length > prefix.length) return { rule, target: apply(rule, path)! };
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
  const found = index.match(normalizePath(url.pathname));
  if(!found) return null;
  const { rule, target } = found;
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
    let path = sampleOf(start.from);
    const seen = [path];
    for(let hop = 0; hop < MAX_HOPS; hop++) {
      const found = index.match(normalizePath(path));
      if(!found) break;
      const next = found.target;
      if(!next.startsWith("/")) break;
      const bare = next.split(/[?#]/)[0]!;
      path = bare;
      if(seen.includes(path)) return [...seen, path];
      seen.push(path);
      if(hop === MAX_HOPS - 1) return seen;
    }
  }
  return null;
}

/** A path a pattern matches: its wildcard and variables replaced by a word. Static paths are returned as they are. */
function sampleOf(path: string): string {
  const filled = path.replace(VARIABLE, "sample");
  return isWildcard(filled) ? `${filled.slice(0, -1)}sample` : filled;
}

/** Whether `rule`'s target can land on a path `candidate` matches. */
function leadsTo(rule: MatchRule, candidate: MatchRule): boolean {
  if(!rule.to.startsWith("/")) return false;
  const to = rule.to.split(/[?#]/)[0]!;
  return new RedirectIndex([candidate]).find(normalizePath(sampleOf(to))) !== null || isWildcard(rule.to) && candidate.from.startsWith(rule.to.slice(0, -1));
}

/** The paths a `from` covers that a live page at `path` would be hidden by. */
export function covers(from: string, path: string): boolean {
  const normalized = normalizePath(path);
  if(variablesOf(from).length) return new RedirectIndex([{ id: "", from, to: "/", status: 301, keepQuery: true }]).find(normalized) !== null;
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
