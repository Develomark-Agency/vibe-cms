import { count, eq, like } from "drizzle-orm";
import { HttpError, type AnyConfig, type RoleRules } from "../config.ts";
import { createDb } from "../db/client.ts";
import { roles as rolesTable, users } from "../db/schema.ts";
import { beyondReach, fitRules, OWNER_ROLE, PRESETS, presetRules, ruleIssues, staleKeys, validRoleName, type RoleSchema, type StoredRole } from "../roles.ts";
import type { Session } from "../server/index.ts";
import type { D1 } from "./platform.ts";

/** How long an isolate trusts its copy of the roles before reading them again. Writes here refresh at once. */
const MAX_AGE = 2000;

/**
 * The site's stored roles (`vibe_roles`), the only roles besides the built-in owner. Each isolate keeps
 * a copy, read again on requests older than a moment and right after a write, so `can()` stays sync.
 */
export class RoleStore {
  #map: Record<string, RoleRules> = {};
  #list: StoredRole[] = [];
  #loadedAt = 0;
  #loading: Promise<void> | null = null;

  constructor(private db: D1) {}

  /** Role name → rules. */
  get map(): Readonly<Record<string, RoleRules>> {
    return this.#map;
  }

  get list(): readonly StoredRole[] {
    return this.#list;
  }

  async refresh(force = false): Promise<void> {
    if(!force && Date.now() - this.#loadedAt < MAX_AGE) return;
    if(!force && this.#loading) return this.#loading;
    const loading = (async () => {
      const rows = await createDb(this.db).select().from(rolesTable).orderBy(rolesTable.name);
      const list = rows.flatMap(row => {
        try {
          return [{ name: row.name, rules: JSON.parse(row.rules) as RoleRules, updatedBy: row.updated_by, updatedAt: row.updated_at }];
        } catch {
          return [];
        }
      });
      this.#list = list;
      this.#map = Object.fromEntries(list.map(role => [role.name, role.rules]));
      this.#loadedAt = Date.now();
    })();
    this.#loading = loading;
    try {
      await loading;
    } finally {
      if(this.#loading === loading) this.#loading = null;
    }
  }
}

/** Content types and locales, for the editor's rule builder and for checking rules. */
export function roleSchema(config: AnyConfig): RoleSchema {
  const collections = (config.collections ?? {}) as Record<string, { label?: string } | undefined>;
  return {
    types: Object.keys(config.schemas).map(name => ({ name, label: collections[name]?.label ?? name })),
    locales: [...(config.locales ?? [config.defaultLocale ?? "en"])]
  };
}

interface RoleState {
  config: AnyConfig,
  db: D1,
  roles: RoleStore,
  org?: { current(): Promise<string | null> }
}

/** Owners (the hub's site admins are owners) and `all` roles: may change any role. */
export function fullRoleManager(state: RoleState, session: Session | null): boolean {
  if(!session || session.readOnly) return false;
  if(session.sub === "dev" || session.roles.includes(OWNER_ROLE)) return true;
  return session.roles.some(role => state.roles.map[role]?.all === true);
}

/** Owners, `all` roles, and `manageRoles` roles, which may only change roles within their own. */
export function canManageRoles(state: RoleState, session: Session | null): boolean {
  if(fullRoleManager(state, session)) return true;
  return Boolean(session && !session.readOnly && session.roles.some(role => state.roles.map[role]?.manageRoles === true));
}

function requireManager(state: RoleState, session: Session | null): Session {
  if(!session) throw new HttpError(401, "Sign in required");
  if(!canManageRoles(state, session)) throw new HttpError(403, "Only owners and people who manage roles can change roles");
  return session;
}

/** The rules of someone's roles. */
export function heldRules(state: RoleState, session: Session): RoleRules[] {
  return session.roles.flatMap(role => (state.roles.map[role] ? [state.roles.map[role]!] : []));
}

/** Why this person can't create, change or hand out a role with `rules`; null when they can. */
export function outOfReach(state: RoleState, session: Session, rules: RoleRules | undefined): string | null {
  if(!rules || fullRoleManager(state, session)) return null;
  const beyond = beyondReach(rules, heldRules(state, session), roleSchema(state.config));
  return beyond.length ? `That goes beyond your own roles: ${beyond.join("; ")}` : null;
}

function requireWithinReach(state: RoleState, session: Session, name: string, rules: RoleRules | undefined) {
  const problem = outOfReach(state, session, rules);
  if(problem) throw new HttpError(403, `${name}: ${problem}`);
}

export function listRoles(state: RoleState, session: Session | null) {
  if(!session) throw new HttpError(401, "Sign in required");
  const schema = roleSchema(state.config);
  return {
    // `editable`: this person may change or delete the role. Partial managers can't touch roles beyond their own.
    roles: state.roles.list.map(role => ({ ...role, stale: staleKeys(role.rules, schema), editable: canManageRoles(state, session) && !outOfReach(state, session, role.rules) })),
    canEdit: canManageRoles(state, session),
    /** Owners and `all` roles; otherwise new roles have to stay within this person's own. */
    fullAccess: fullRoleManager(state, session)
  };
}

/** Whether any person could still manage the site if `name` had `next` rules (null: deleted). */
async function someoneCanManage(state: RoleState, name: string, next: RoleRules | null): Promise<boolean> {
  // An org site's hub admins are always owners there.
  if(await state.org?.current()) return true;
  const orm = createDb(state.db);
  const [owners] = await orm.select({ n: count() }).from(users).where(like(users.roles, `%"${OWNER_ROLE}"%`));
  if((owners?.n ?? 0) > 0) return true;
  const managing = new Set(Object.entries(state.roles.map).filter(([role, rules]) => (role === name ? next?.all : rules.all)).map(([role]) => role));
  if(next?.all) managing.add(name);
  if(!managing.size) return false;
  const rows = await orm.select({ roles: users.roles }).from(users);
  return rows.some(row => (JSON.parse(row.roles) as string[]).some(role => managing.has(role)));
}

export async function saveRole(state: RoleState, session: Session | null, name: string, input: { rules?: unknown }) {
  const by = requireManager(state, session);
  const invalidName = validRoleName(name);
  if(invalidName) throw new HttpError(400, invalidName);
  const issues = ruleIssues(input.rules, roleSchema(state.config));
  if(issues.length) throw new HttpError(400, issues.join("; "), { issues });
  const rules = input.rules as RoleRules;
  const current = state.roles.map[name];
  // People who manage roles without being owners stay within their own: what the role had, and what it gets.
  requireWithinReach(state, by, name, current);
  requireWithinReach(state, by, name, rules);
  if(current?.all && !rules.all && !await someoneCanManage(state, name, rules)) {
    throw new HttpError(409, "Nobody else could manage the site after this change");
  }
  await createDb(state.db).insert(rolesTable)
    .values({ name, rules: JSON.stringify(rules), updated_by: by.name ?? by.email ?? by.sub, updated_at: Date.now() })
    .onConflictDoUpdate({ target: rolesTable.name, set: { rules: JSON.stringify(rules), updated_by: by.name ?? by.email ?? by.sub, updated_at: Date.now() } });
  await state.roles.refresh(true);
  return state.roles.list.find(role => role.name === name)!;
}

export async function deleteRole(state: RoleState, session: Session | null, name: string) {
  const by = requireManager(state, session);
  if(!state.roles.map[name]) throw new HttpError(404, `No role called ${name}`);
  requireWithinReach(state, by, name, state.roles.map[name]);
  if(state.roles.map[name]!.all && !await someoneCanManage(state, name, null)) {
    throw new HttpError(409, "Nobody else could manage the site after this change");
  }
  await createDb(state.db).delete(rolesTable).where(eq(rolesTable.name, name));
  await state.roles.refresh(true);
}

export function presets(state: RoleState) {
  const schema = roleSchema(state.config);
  return PRESETS.map(preset => {
    const fitted = fitRules(presetRules(preset, schema, state.config.defaultLocale), schema);
    return { name: preset.name, label: preset.label, description: preset.description, rules: fitted.rules, skipped: fitted.skipped };
  });
}

/**
 * Writes a set of roles at once, as the hub does when it applies a template. Rules for types the site
 * lacks are skipped and reported; the apply never fails for that. `replace` drops roles not in the set.
 */
export async function applyRoles(state: RoleState, session: Session | null, input: { roles?: unknown, replace?: unknown }) {
  const by = requireManager(state, session);
  // Templates replace roles wholesale: owners only.
  if(!fullRoleManager(state, by)) throw new HttpError(403, "Only owners can apply a set of roles");
  if(typeof input.roles !== "object" || input.roles === null || Array.isArray(input.roles)) throw new HttpError(400, "Expected roles as { name: rules }");
  const schema = roleSchema(state.config);
  const skipped: string[] = [];
  const now = Date.now();
  const orm = createDb(state.db);
  const entries = Object.entries(input.roles as Record<string, RoleRules>);
  for(const [name] of entries) {
    const invalid = validRoleName(name);
    if(invalid) throw new HttpError(400, `${name}: ${invalid}`);
  }
  if(input.replace === true) {
    const keep = new Set(entries.map(([name]) => name));
    for(const role of state.roles.list) if(!keep.has(role.name)) await orm.delete(rolesTable).where(eq(rolesTable.name, role.name));
  }
  for(const [name, raw] of entries) {
    const fitted = fitRules(raw, schema);
    skipped.push(...fitted.skipped.map(reason => `${name}: ${reason}`));
    const issues = ruleIssues(fitted.rules, schema);
    if(issues.length) throw new HttpError(400, `${name}: ${issues.join("; ")}`);
    const value = JSON.stringify(fitted.rules);
    const updatedBy = by.name ?? by.email ?? by.sub;
    await orm.insert(rolesTable).values({ name, rules: value, updated_by: updatedBy, updated_at: now })
      .onConflictDoUpdate({ target: rolesTable.name, set: { rules: value, updated_by: updatedBy, updated_at: now } });
  }
  await state.roles.refresh(true);
  return { roles: state.roles.list, skipped };
}
