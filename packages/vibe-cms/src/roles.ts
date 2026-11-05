import type { Action, RoleRules } from "./config.ts";

/**
 * Roles as data: the shapes a site stores and the hub's templates copy, the packaged presets, and the
 * checks both run before writing a role. No database here, so the hub can import it.
 */

export const ACTIONS: readonly Action[] = ["read", "write", "publish", "delete"];

/** Rule keys that aren't content types. */
const SPECIAL = new Set(["all", "publish", "write", "media", "siteSettings", "backups", "manageRoles", "*"]);

/** Built in, never stored: every permission, plus managing roles and who may sign in. */
export const OWNER_ROLE = "owner";

export interface StoredRole {
  name: string,
  rules: RoleRules,
  updatedBy: string | null,
  updatedAt: number | null
}

/** What a site has that rules can name: its content types (with labels) and locales. */
export interface RoleSchema {
  types: Array<{ name: string, label: string }>,
  locales: string[]
}

export interface Preset {
  name: string,
  label: string,
  description: string,
  rules: RoleRules
}

/**
 * Starting points, not live roles: adding one copies its rules into the site's stored roles with no
 * link back. The Translator preset writes in every locale but the default; trim it after adding.
 */
export const PRESETS: readonly Preset[] = [
  {
    name: "admin",
    label: "Admin",
    description: "All content, media, site settings and backups",
    rules: { "*": ["read", "write", "publish", "delete"], media: ["read", "write", "delete"], siteSettings: true, backups: true }
  },
  {
    name: "editor",
    label: "Editor",
    description: "Write and publish everything, upload media",
    rules: { "*": ["read", "write", "publish"], media: ["read", "write"] }
  },
  {
    name: "contributor",
    label: "Contributor",
    description: "Write drafts, no publishing",
    rules: { "*": ["read", "write"], media: ["read", "write"] }
  },
  {
    name: "translator",
    label: "Translator",
    description: "Read everything, write in other locales",
    rules: { "*": ["read"], write: { locales: [] } }
  }
];

/**
 * Rules written before publishing had to be listed: there, `write` implied `publish` unless the role
 * said `publish: false`. Returns the same permissions in today's terms. Config roles go through this
 * when they're copied onto the site.
 */
export function normalizeLegacyRules(rules: RoleRules): RoleRules {
  const out: RoleRules = {};
  const publishes = rules.publish !== false;
  for(const [key, value] of Object.entries(rules)) {
    if(key === "publish") continue;
    if(!SPECIAL.has(key) || key === "*") {
      const actions = new Set(value as Action[]);
      if(publishes && actions.has("write")) actions.add("publish");
      if(!publishes) actions.delete("publish");
      out[key] = ACTIONS.filter(action => actions.has(action));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** A preset's rules for one site: the translator writes in its non-default locales. */
export function presetRules(preset: Preset, schema: RoleSchema, defaultLocale?: string): RoleRules {
  const rules = structuredClone(preset.rules);
  if(rules.write && typeof rules.write === "object" && "locales" in rules.write && rules.write.locales.length === 0) {
    const others = schema.locales.filter(locale => locale !== (defaultLocale ?? schema.locales[0]));
    rules.write = { locales: others.length ? others : schema.locales };
  }
  return rules;
}

export function validRoleName(name: string): string | null {
  if(!/^[a-z][a-z0-9_-]{0,39}$/i.test(name)) return "Role names are letters, digits, - and _, starting with a letter, up to 40 characters";
  if(name === OWNER_ROLE) return "owner is built in";
  return null;
}

function isActions(value: unknown): value is Action[] {
  return Array.isArray(value) && value.every(action => ACTIONS.includes(action as Action));
}

/** Rule problems against a site's schema: unknown keys, unknown actions, unknown locales. Empty when valid. */
export function ruleIssues(rules: unknown, schema: RoleSchema): string[] {
  if(typeof rules !== "object" || rules === null || Array.isArray(rules)) return ["Rules must be an object"];
  const types = new Set(schema.types.map(type => type.name));
  const issues: string[] = [];
  for(const [key, value] of Object.entries(rules as Record<string, unknown>)) {
    if(value === undefined) continue;
    if(key === "backups") {
      if(typeof value !== "boolean" && value !== "take") issues.push("backups must be true, false or \"take\"");
    } else if(["all", "publish", "siteSettings", "manageRoles"].includes(key)) {
      if(typeof value !== "boolean") issues.push(`${key} must be true or false`);
    } else if(key === "write") {
      const locales = (value as { locales?: unknown })?.locales;
      if(!Array.isArray(locales) || locales.some(l => typeof l !== "string")) issues.push("write must be { locales: [...] }");
      else for(const locale of locales as string[]) if(!schema.locales.includes(locale)) issues.push(`Locale "${locale}" isn't one of this site's locales`);
    } else if(key === "media" || key === "*" || types.has(key)) {
      if(!isActions(value)) issues.push(`${key} must be a list of ${ACTIONS.join(", ")}`);
    } else {
      issues.push(`"${key}" isn't a content type on this site`);
    }
  }
  return issues;
}

/**
 * Rules trimmed to what a site has: rules for content types it lacks and locales it doesn't use are
 * dropped and reported. Used when a template or preset is copied onto a site.
 */
export function fitRules(rules: RoleRules, schema: RoleSchema): { rules: RoleRules, skipped: string[] } {
  const types = new Set(schema.types.map(type => type.name));
  const out: RoleRules = {};
  const skipped: string[] = [];
  for(const [key, value] of Object.entries(rules)) {
    if(value === undefined) continue;
    if(key === "write" && typeof value === "object" && !Array.isArray(value)) {
      const locales = (value as { locales: string[] }).locales;
      const kept = locales.filter(locale => schema.locales.includes(locale));
      for(const locale of locales) if(!kept.includes(locale)) skipped.push(`locale ${locale} doesn't exist on this site`);
      out.write = { locales: kept };
    } else if(SPECIAL.has(key) || types.has(key)) {
      out[key] = value;
    } else {
      skipped.push(`${key} doesn't exist on this site`);
    }
  }
  return { rules: out, skipped };
}

/** Rule keys naming content types a site doesn't have: ignored when checking access, flagged in the editor. */
export function staleKeys(rules: RoleRules, schema: RoleSchema): string[] {
  const types = new Set(schema.types.map(type => type.name));
  return Object.keys(rules).filter(key => !SPECIAL.has(key) && !types.has(key));
}

/** One line describing what a role may do, for lists. */
export function describeRules(rules: RoleRules): string {
  if(rules.all) return "Everything";
  const parts: string[] = [];
  const types = Object.entries(rules).filter(([key, value]) => !SPECIAL.has(key) && Array.isArray(value) && value.length);
  const star = rules["*"] as Action[] | undefined;
  if(star?.length) parts.push(!star.includes("write") ? "Reads all content" : star.includes("publish") && rules.publish !== false ? "All content" : "All content, drafts only");
  if(types.length) parts.push(types.map(([key]) => key).join(", "));
  if(rules.write?.locales?.length) parts.push(`writes in ${rules.write.locales.join(", ")}`);
  if(rules.media?.length) parts.push("media");
  if(rules.siteSettings) parts.push("settings");
  if(rules.backups) parts.push(rules.backups === "take" ? "takes backups" : "backups");
  if(rules.manageRoles) parts.push("manages roles");
  return parts.join(", ") || "Nothing yet";
}

// --- Granting up to your own ---------------------------------------------------------

/** What a set of roles allows, flattened: the most any of them gives, per content type and switch. */
interface Reach {
  all: boolean,
  /** Per content type, and `*` for types without their own rule (and types added later). */
  types: Map<string, Set<Action>>,
  media: Set<Action>,
  /** null: writes in every locale. */
  locales: Set<string> | null,
  siteSettings: boolean,
  /** 0 none, 1 take, 2 take and restore. */
  backups: number,
  manageRoles: boolean
}

function typeActions(rules: RoleRules, key: string): Action[] {
  const own = rules[key];
  const actions = new Set<Action>((Array.isArray(own) ? own : rules["*"] as Action[] | undefined) ?? []);
  if(rules.write && actions.size) actions.add("write");
  if(rules.publish === false) actions.delete("publish");
  if(rules.publish === true && actions.has("write")) actions.add("publish");
  return [...actions];
}

function anyWrite(rules: RoleRules): boolean {
  return Boolean(rules.write) || Object.entries(rules).some(([key, value]) => key !== "media" && !SPECIAL.has(key) && Array.isArray(value) && value.includes("write"))
    || (Array.isArray(rules["*"]) && rules["*"].includes("write"));
}

function reach(roles: RoleRules[], types: string[]): Reach {
  const out: Reach = { all: false, types: new Map(), media: new Set(), locales: new Set(), siteSettings: false, backups: 0, manageRoles: false };
  for(const key of [...types, "*"]) out.types.set(key, new Set());
  for(const rules of roles) {
    if(rules.all) out.all = true;
    for(const key of [...types, "*"]) for(const action of typeActions(rules, key)) out.types.get(key)!.add(action);
    for(const action of rules.media ?? (anyWrite(rules) ? ["read", "write"] : ["read"]) as Action[]) out.media.add(action);
    if(anyWrite(rules)) {
      if(!rules.write) out.locales = null;
      else if(out.locales) for(const locale of rules.write.locales) out.locales.add(locale);
    }
    if(rules.siteSettings) out.siteSettings = true;
    out.backups = Math.max(out.backups, rules.backups === true ? 2 : rules.backups === "take" ? 1 : 0);
    if(rules.manageRoles) out.manageRoles = true;
  }
  return out;
}

/**
 * Why `candidate` goes beyond what `holder` (someone's roles) allows, in words; empty when it doesn't.
 * Used for people who manage roles without being owners: they may only create, edit and hand out
 * roles that stay within their own.
 */
export function beyondReach(candidate: RoleRules, holder: RoleRules[], schema: RoleSchema): string[] {
  const types = schema.types.map(type => type.name);
  const mine = reach(holder, types);
  if(mine.all) return [];
  const theirs = reach([candidate], types);
  const problems: string[] = [];
  if(theirs.all) problems.push("Everything");
  for(const key of [...types, "*"]) {
    const extra = [...theirs.types.get(key)!].filter(action => !mine.types.get(key)!.has(action));
    if(extra.length) problems.push(`${extra.join(", ")} on ${key === "*" ? "other types" : key}`);
  }
  const media = [...theirs.media].filter(action => !mine.media.has(action));
  if(media.length) problems.push(`${media.join(", ")} in the media library`);
  if(mine.locales && anyWrite(candidate)) {
    const extra = theirs.locales === null ? ["every language"] : [...theirs.locales].filter(locale => !mine.locales!.has(locale));
    if(extra.length) problems.push(`writing in ${extra.join(", ")}`);
  }
  if(theirs.siteSettings && !mine.siteSettings) problems.push("site settings");
  if(theirs.backups > mine.backups) problems.push(theirs.backups === 2 ? "restoring backups" : "taking backups");
  if(theirs.manageRoles && !mine.manageRoles) problems.push("managing roles");
  return problems;
}
