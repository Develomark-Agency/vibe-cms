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
  return isWildcard(path) || path.includes("?") || /\{[^{}/]*\}/.test(path);
}

/** A rule's `from`, apart: the path, and the query parameters it asks for (`/place?town={name}`). No `?`, no parameters. */
export function fromParts(from: string): { path: string, query: Array<[string, string]> } {
  const mark = from.indexOf("?");
  if(mark < 0) return { path: from, query: [] };
  return {
    path: from.slice(0, mark),
    query: from.slice(mark + 1).split("&").map(pair => {
      const equals = pair.indexOf("=");
      return (equals < 0 ? [pair, ""] : [pair.slice(0, equals), pair.slice(equals + 1)]) as [string, string];
    })
  };
}

/** A `from` with its variables' names left out: two rules with the same shape match the same requests. */
export function shapeOf(from: string): string {
  return from.replace(VARIABLE, "{}");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The query a rule's `from` asks for, checked and in a fixed order, so the same rule can't be added twice by writing it differently. */
function checkQuery(query: string): { canonical: string, names: string[] } {
  const pairs = query.split("&");
  const keys: string[] = [];
  const names: string[] = [];
  for(const pair of pairs) {
    const equals = pair.indexOf("=");
    if(equals < 1) throw new RedirectError(`“${pair}” in the query needs a name and a value: name=value or name={variable}`);
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if(!/^[\w.~%-]+$/.test(key)) throw new RedirectError(`“${key}” isn't a query parameter name: letters, digits and _ . - ~ only`);
    if(keys.includes(key)) throw new RedirectError(`The query asks for “${key}” twice`);
    keys.push(key);
    const name = /^\{(\w+)\}$/.exec(value)?.[1];
    if(name) {
      if(names.includes(name)) throw new RedirectError(`{${name}} is used twice in “from”`);
      names.push(name);
    } else if(/[{}=?]/.test(value)) {
      throw new RedirectError(`“${value}” isn't a value: write a plain value, or a whole variable like {name}`);
    }
  }
  return { canonical: [...pairs].sort((a, b) => (a.split("=")[0]! < b.split("=")[0]! ? -1 : 1)).join("&"), names };
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
  const whole = input.from.trim();
  const to = input.to.trim();
  if(!whole.startsWith("/")) throw new RedirectError("“From” has to be a path starting with /");
  if(/[#\s]/.test(whole)) throw new RedirectError("“From” can't have spaces or a #");
  const mark = whole.indexOf("?");
  const from = mark < 0 ? whole : whole.slice(0, mark);
  const query = mark < 0 ? null : checkQuery(whole.slice(mark + 1));
  const declared = variableProblems(from, query?.names ?? [], to);
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
  if(!query && !isWildcard(normalized) && target === normalized) throw new RedirectError("“From” and “to” are the same");
  return { from: query ? `${normalized}?${query.canonical}` : normalized, to: target, status: status as RedirectStatus, keepQuery: input.keepQuery ?? true };
}

/** What's wrong with the variables of a rule, or null. A rule without any (the usual one) is never touched. */
function variableProblems(from: string, queryNames: string[], to: string): string | null {
  if(!/[{}]/.test(from) && !queryNames.length && !/[{}]/.test(to)) return null;
  const names: string[] = [];
  for(const segment of from.split("/")) {
    if(!/[{}]/.test(segment)) continue;
    const name = /^\{(\w+)\}$/.exec(segment)?.[1];
    if(!name) return `“${segment}” isn't a variable: write a whole segment like {name}, with letters, digits or _`;
    if(names.includes(name)) return `{${name}} is used twice in “from”`;
    names.push(name);
  }
  for(const name of queryNames) {
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
  literals: number,
  wildcard: boolean
}

function compile(rule: MatchRule, original: MatchRule = rule): Pattern {
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
  return { rule: original, names, regex: new RegExp(`^${parts.join("/")}${wildcard ? "(.+)" : ""}$`), literals, wildcard };
}

/** Where a pattern sends a path, or null when it doesn't match. Variables and `*` are filled in as they came in the path. */
function fillPattern(pattern: Pattern, path: string): string | null {
  const match = pattern.regex.exec(path);
  if(!match) return null;
  const values = new Map(pattern.names.map((name, index) => [name, match[index + 1]!]));
  const rest = isWildcard(pattern.rule.from) ? match[pattern.names.length + 1]! : "";
  return pattern.rule.to.replace(VARIABLE, (_, name: string) => values.get(name) ?? "").replace("*", () => rest);
}

/** Where a rule that asks for query parameters sends a request, or null when the path or any parameter doesn't match. */
function fillQueried(pattern: Pattern, pairs: Array<[string, string]>, path: string, raw: Array<[string, string]>): { target: string, consumed: string[] } | null {
  const match = pattern.regex.exec(path);
  if(!match) return null;
  const values = new Map(pattern.names.map((name, index) => [name, match[index + 1]!]));
  const rest = pattern.wildcard ? match[pattern.names.length + 1]! : "";
  const consumed: string[] = [];
  for(const [key, want] of pairs) {
    const given = raw.find(([name]) => name === key);
    if(!given) return null;
    const name = /^\{(\w+)\}$/.exec(want)?.[1];
    // A variable takes any value but an empty one; as in a path, it's passed on as it came.
    if(name) {
      if(given[1] === "") return null;
      values.set(name, given[1]);
    } else if(decode(given[1]) !== decode(want)) {
      return null;
    }
    consumed.push(key);
  }
  return { target: pattern.rule.to.replace(VARIABLE, (_, name: string) => values.get(name) ?? "").replace("*", () => rest), consumed };
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
  /** Rules that ask for query parameters (`/place?town={name}`). Empty unless the site has any, and then checked first. */
  private readonly queried: Array<{ pattern: Pattern, pairs: Array<[string, string]> }> = [];

  constructor(rules: readonly MatchRule[]) {
    for(const rule of rules) {
      if(rule.from.includes("?")) {
        const { path, query } = fromParts(rule.from);
        this.queried.push({ pattern: compile({ ...rule, from: path }, rule), pairs: query });
      } else if(/\{\w+\}/.test(rule.from)) this.patterns.push(compile(rule));
      else if(isWildcard(rule.from)) this.wild.push({ prefix: rule.from.slice(0, -1), rule });
      else this.exact.set(rule.from, rule);
    }
    // More parameters asked for first, then more fixed segments.
    this.queried.sort((a, b) => b.pairs.length - a.pairs.length || b.pattern.literals - a.pattern.literals || b.pattern.rule.from.length - a.pattern.rule.from.length);
    this.wild.sort((a, b) => b.prefix.length - a.prefix.length);
    // More fixed segments first, a pattern without a wildcard before one with, then the longer.
    this.patterns.sort((a, b) => b.literals - a.literals || Number(isWildcard(a.rule.from)) - Number(isWildcard(b.rule.from)) || b.rule.from.length - a.rule.from.length);
  }

  get size(): number {
    return this.exact.size + this.wild.length + this.patterns.length + this.queried.length;
  }

  /** The rule for a normalized path: an exact match first, then patterns with variables, then the longest wildcard prefix. */
  find(path: string, query = ""): MatchRule | null {
    return this.match(path, query)?.rule ?? null;
  }

  /**
   * The rule for a path (and the request's raw query, without the `?`) and the target it sends it to. `consumed`
   * names the query parameters a rule asked for, which aren't passed on.
   */
  match(path: string, query = ""): { rule: MatchRule, target: string, consumed?: string[] } | null {
    if(this.queried.length && query) {
      const raw = query.split("&").map(pair => {
        const equals = pair.indexOf("=");
        return (equals < 0 ? [decode(pair), ""] : [decode(pair.slice(0, equals)), pair.slice(equals + 1)]) as [string, string];
      });
      for(const { pattern, pairs } of this.queried) {
        const found = fillQueried(pattern, pairs, path, raw);
        if(found) return { rule: pattern.rule, ...found };
      }
    }
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
  const found = index.match(normalizePath(url.pathname), url.search.slice(1));
  if(!found) return null;
  const { rule, target, consumed } = found;
  let location = target;
  if(target.startsWith("/") && !target.includes("?") && !target.includes("#") && url.pathname.length > 1 && url.pathname.endsWith("/") && target !== "/" && !target.endsWith("/")) location = `${target}/`;
  // The parameters a rule matched on are used up in its target; the rest go along.
  const passed = consumed ? url.search.slice(1).split("&").filter(pair => pair && !consumed.includes(decode(pair.split("=")[0]!))).join("&") : url.search.slice(1);
  if(rule.keepQuery && passed) location += (location.includes("?") ? "&" : "?") + passed;
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
    const first = sampleRequest(start.from);
    let path = first.path;
    let query = first.query;
    const seen = [path];
    for(let hop = 0; hop < MAX_HOPS; hop++) {
      const found = index.match(normalizePath(path), query);
      if(!found) break;
      const next = found.target;
      if(!next.startsWith("/")) break;
      [path, query = ""] = next.split("#")[0]!.split("?") as [string, string?];
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

/** A request a rule's `from` matches: variables and the wildcard replaced by a word, and the query it asks for. */
function sampleRequest(from: string): { path: string, query: string } {
  const { path, query } = fromParts(from);
  return { path: sampleOf(path), query: query.map(([key, value]) => `${key}=${value.replace(VARIABLE, "sample")}`).join("&") };
}

/** Whether `rule`'s target can land on a request `candidate` matches. */
function leadsTo(rule: MatchRule, candidate: MatchRule): boolean {
  if(!rule.to.startsWith("/")) return false;
  const [to, query = ""] = rule.to.split("#")[0]!.split("?") as [string, string?];
  return new RedirectIndex([candidate]).find(normalizePath(sampleOf(to)), query.replace(VARIABLE, "sample")) !== null || isWildcard(rule.to) && candidate.from.startsWith(rule.to.slice(0, -1));
}

/** The paths a `from` covers that a live page at `path` would be hidden by. */
export function covers(from: string, path: string): boolean {
  // A rule that asks for query parameters leaves the page's own address alone.
  if(from.includes("?")) return false;
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
