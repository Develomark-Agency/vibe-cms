import type { Action, PluginGrants, RoleRules } from "./config.ts";
import { permissionLevels, type PluginPermission } from "./descriptor.ts";

/**
 * Roles as data: the shapes a site stores and the hub's templates copy, the packaged presets, and the
 * checks both run before writing a role. No database here, so the hub can import it.
 */

export const ACTIONS: readonly Action[] = ["read", "write", "publish", "delete"];

/** Rule keys that aren't content types. */
const SPECIAL = new Set(["all", "publish", "write", "media", "siteSettings", "backups", "manageRoles", "viewActivity", "manageRedirects", "manageTrash", "manageActivity", "manageScheduledBackups", "plugins", "*"]);

/** Built in, never stored: every permission, plus managing roles and who may sign in. */
export const OWNER_ROLE = "owner";

export interface StoredRole {
  name: string,
  rules: RoleRules,
  updatedBy: string | null,
  updatedAt: number | null
}

/** What a site has that rules can name: its content types (with labels), locales, and plugins' permissions. */
export interface RoleSchema {
  types: Array<{ name: string, label: string }>,
  locales: string[],
  /** Plugins that add permissions. Missing from older sites, which have none. */
  plugins?: Array<{ name: string, permissions: Record<string, PluginPermission> }>
}

// --- Plugin permissions --------------------------------------------------------------

/**
 * How much of a plugin's permission a stored value gives: 0 nothing, 1 for yes, or the level's place
 * (1 is the lowest). A level the plugin doesn't declare (any more) gives nothing.
 */
export function grantRank(permission: PluginPermission, value: unknown): number {
  const levels = permissionLevels(permission);
  if(!levels) return value === true ? 1 : 0;
  return typeof value === "string" ? levels.findIndex(level => level.value === value) + 1 : 0;
}

/** The rank a check needs: any level when none is named. -1 for a level the permission doesn't have. */
export function neededRank(permission: PluginPermission, level?: string): number {
  const levels = permissionLevels(permission);
  if(!levels) return level === undefined ? 1 : -1;
  if(level === undefined) return 1;
  return levels.findIndex(entry => entry.value === level) + 1 || -1;
}

/** The value that stores a rank: `true`, or the level's value. Undefined for 0. */
export function grantValue(permission: PluginPermission, rank: number): true | string | undefined {
  if(rank <= 0) return undefined;
  const levels = permissionLevels(permission);
  return levels ? levels[Math.min(rank, levels.length) - 1]!.value : true;
}

/** Every declared plugin permission, flat. */
function pluginPermissions(schema: RoleSchema): Array<{ plugin: string, key: string, permission: PluginPermission }> {
  return (schema.plugins ?? []).flatMap(plugin => Object.entries(plugin.permissions).map(([key, permission]) => ({ plugin: plugin.name, key, permission })));
}

/** A permission in words, for messages: `"Manage API keys" (stripe)`, with the level when it has them. */
function permissionPhrase(plugin: string, permission: PluginPermission, rank: number): string {
  const levels = permissionLevels(permission);
  const level = levels && rank > 0 ? `: ${levels[Math.min(rank, levels.length) - 1]!.label}` : "";
  return `${permission.label}${level} (${plugin})`;
}

/** Rule problems in a role's `plugins`. */
function pluginIssues(value: unknown, schema: RoleSchema): string[] {
  if(typeof value !== "object" || value === null || Array.isArray(value)) return ["plugins must be { plugin: { permission: value } }"];
  const issues: string[] = [];
  for(const [plugin, grants] of Object.entries(value as Record<string, unknown>)) {
    const declared = schema.plugins?.find(entry => entry.name === plugin)?.permissions;
    if(!declared) {
      issues.push(`"${plugin}" isn't a plugin with permissions on this site`);
      continue;
    }
    if(typeof grants !== "object" || grants === null || Array.isArray(grants)) {
      issues.push(`plugins.${plugin} must be { permission: value }`);
      continue;
    }
    for(const [key, grant] of Object.entries(grants as Record<string, unknown>)) {
      const permission = declared[key];
      if(!permission) issues.push(`"${key}" isn't one of ${plugin}'s permissions`);
      else if(grantRank(permission, grant) === 0) {
        const levels = permissionLevels(permission);
        issues.push(levels ? `plugins.${plugin}.${key} must be one of ${levels.map(level => level.value).join(", ")}` : `plugins.${plugin}.${key} must be true`);
      }
    }
  }
  return issues;
}

/** A role's `plugins` trimmed to what the site's plugins declare, with what was dropped. */
function fitGrants(value: PluginGrants, schema: RoleSchema): { grants: PluginGrants, skipped: string[] } {
  const grants: PluginGrants = {};
  const skipped: string[] = [];
  for(const [plugin, entries] of Object.entries(value ?? {})) {
    const declared = schema.plugins?.find(entry => entry.name === plugin)?.permissions;
    for(const [key, grant] of Object.entries(entries ?? {})) {
      const permission = declared?.[key];
      if(!declared) skipped.push(`plugin ${plugin} isn't on this site`);
      else if(!permission) skipped.push(`permission ${plugin}.${key} doesn't exist on this site`);
      else if(grantRank(permission, grant) === 0) skipped.push(`${plugin}.${key} has no level "${String(grant)}"`);
      else (grants[plugin] ??= {})[key] = grant;
    }
  }
  return { grants, skipped: [...new Set(skipped)] };
}

/** Removes stale entries (as {@link staleKeys} names them) from rules. */
export function withoutStale(rules: RoleRules, stale: string[]): RoleRules {
  const out: RoleRules = {};
  for(const [key, value] of Object.entries(rules)) {
    if(stale.includes(key)) continue;
    if(key === "plugins" && value && typeof value === "object") {
      const grants: PluginGrants = {};
      for(const [plugin, entries] of Object.entries(value as PluginGrants)) {
        const kept = Object.fromEntries(Object.entries(entries).filter(([permission]) => !stale.includes(`${plugin}.${permission}`)));
        if(Object.keys(kept).length) grants[plugin] = kept;
      }
      if(Object.keys(grants).length) out.plugins = grants;
      continue;
    }
    out[key] = value;
  }
  return out;
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
    rules: { "*": ["read", "write", "publish", "delete"], media: ["read", "write", "delete"], siteSettings: true, manageRedirects: true, manageTrash: true, manageActivity: true, manageScheduledBackups: true, backups: true }
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
    } else if(key === "publish") {
      if(value !== false) issues.push("publish can only be false");
    } else if(["all", "siteSettings", "manageRoles", "viewActivity", "manageRedirects", "manageTrash", "manageActivity", "manageScheduledBackups"].includes(key)) {
      if(typeof value !== "boolean") issues.push(`${key} must be true or false`);
    } else if(key === "write") {
      const locales = (value as { locales?: unknown })?.locales;
      if(!Array.isArray(locales) || locales.some(l => typeof l !== "string")) issues.push("write must be { locales: [...] }");
      else for(const locale of locales as string[]) if(!schema.locales.includes(locale)) issues.push(`Locale "${locale}" isn't one of this site's locales`);
    } else if(key === "plugins") {
      issues.push(...pluginIssues(value, schema));
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
    } else if(key === "plugins") {
      const fitted = fitGrants(value as PluginGrants, schema);
      skipped.push(...fitted.skipped);
      if(Object.keys(fitted.grants).length) out.plugins = fitted.grants;
    } else if(SPECIAL.has(key) || types.has(key)) {
      out[key] = value;
    } else {
      skipped.push(`${key} doesn't exist on this site`);
    }
  }
  return { rules: out, skipped };
}

/**
 * Rules naming what a site doesn't have: content types by their key, plugin permissions as
 * `<plugin>.<permission>` (including levels the plugin no longer has). Ignored when checking access,
 * flagged in the editor.
 */
export function staleKeys(rules: RoleRules, schema: RoleSchema): string[] {
  const types = new Set(schema.types.map(type => type.name));
  const stale = Object.keys(rules).filter(key => !SPECIAL.has(key) && !types.has(key));
  for(const [plugin, entries] of Object.entries(rules.plugins ?? {})) {
    const declared = schema.plugins?.find(entry => entry.name === plugin)?.permissions;
    for(const [key, grant] of Object.entries(entries ?? {})) {
      const permission = declared?.[key];
      if(!permission || grantRank(permission, grant) === 0) stale.push(`${plugin}.${key}`);
    }
  }
  return stale;
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
  if(rules.manageRedirects) parts.push("redirects");
  if(rules.manageTrash) parts.push("trash retention");
  if(rules.manageActivity) parts.push("activity retention");
  if(rules.manageScheduledBackups) parts.push("scheduled backups");
  if(rules.backups) parts.push(rules.backups === "take" ? "takes backups" : "backups");
  if(rules.manageRoles) parts.push("manages roles");
  if(rules.viewActivity) parts.push("sees activity");
  const plugins = Object.entries(rules.plugins ?? {}).filter(([, grants]) => Object.keys(grants ?? {}).length).map(([plugin]) => plugin);
  if(plugins.length) parts.push(`${plugins.join(", ")} permissions`);
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
  manageRoles: boolean,
  viewActivity: boolean,
  manageRedirects: boolean,
  manageTrash: boolean,
  manageActivity: boolean,
  manageScheduledBackups: boolean,
  /** Per `<plugin>.<permission>`, the highest rank any role gives. */
  plugins: Map<string, number>
}

function typeActions(rules: RoleRules, key: string): Action[] {
  const own = rules[key];
  const actions = new Set<Action>((Array.isArray(own) ? own : rules["*"] as Action[] | undefined) ?? []);
  if(rules.write && actions.size) actions.add("write");
  if(rules.publish === false) actions.delete("publish");
  return [...actions];
}

function anyWrite(rules: RoleRules): boolean {
  return Boolean(rules.write) || Object.entries(rules).some(([key, value]) => key !== "media" && !SPECIAL.has(key) && Array.isArray(value) && value.includes("write"))
    || (Array.isArray(rules["*"]) && rules["*"].includes("write"));
}

function reach(roles: RoleRules[], schema: RoleSchema): Reach {
  const types = schema.types.map(type => type.name);
  const out: Reach = { all: false, types: new Map(), media: new Set(), locales: new Set(), siteSettings: false, backups: 0, manageRoles: false, viewActivity: false, manageRedirects: false, manageTrash: false, manageActivity: false, manageScheduledBackups: false, plugins: new Map() };
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
    if(rules.viewActivity) out.viewActivity = true;
    if(rules.manageRedirects) out.manageRedirects = true;
    if(rules.manageTrash) out.manageTrash = true;
    if(rules.manageActivity) out.manageActivity = true;
    if(rules.manageScheduledBackups) out.manageScheduledBackups = true;
    for(const { plugin, key, permission } of pluginPermissions(schema)) {
      const rank = grantRank(permission, rules.plugins?.[plugin]?.[key]);
      if(rank > (out.plugins.get(`${plugin}.${key}`) ?? 0)) out.plugins.set(`${plugin}.${key}`, rank);
    }
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
  const mine = reach(holder, schema);
  if(mine.all) return [];
  const theirs = reach([candidate], schema);
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
  if(theirs.viewActivity && !mine.viewActivity) problems.push("seeing activity");
  if(theirs.manageRedirects && !mine.manageRedirects) problems.push("managing redirects");
  if(theirs.manageTrash && !mine.manageTrash) problems.push("changing how long the trash is kept");
  if(theirs.manageActivity && !mine.manageActivity) problems.push("changing how long activity is kept");
  if(theirs.manageScheduledBackups && !mine.manageScheduledBackups) problems.push("turning scheduled backups on or off");
  for(const { plugin, key, permission } of pluginPermissions(schema)) {
    const rank = theirs.plugins.get(`${plugin}.${key}`) ?? 0;
    if(rank > (mine.plugins.get(`${plugin}.${key}`) ?? 0)) problems.push(permissionPhrase(plugin, permission, rank));
  }
  return problems;
}
