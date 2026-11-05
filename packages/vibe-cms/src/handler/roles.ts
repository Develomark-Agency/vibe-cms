import { count, eq, like } from "drizzle-orm";
import { HttpError, type AnyConfig, type RoleRules } from "../config.ts";
import { createDb } from "../db/client.ts";
import { hubUsers, meta, roles as rolesTable, users } from "../db/schema.ts";
import { fitRules, normalizeLegacyRules, OWNER_ROLE, PRESETS, presetRules, ruleIssues, staleKeys, validRoleName, type RoleSchema, type StoredRole } from "../roles.ts";
import type { Session } from "../server/index.ts";
import { getMeta } from "./db.ts";
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

/**
 * Upgrade path: a config that still has `permissions.roles` writes them into `vibe_roles` once,
 * skipping names already stored, and warns to remove the key.
 */
export async function importConfigRoles(db: D1, config: AnyConfig): Promise<void> {
  const configured = config.permissions?.roles;
  if(!configured || !Object.keys(configured).length) return;
  if(await getMeta(db, "roles_imported")) return;
  const orm = createDb(db);
  const now = Date.now();
  for(const [name, rules] of Object.entries(configured)) {
    await orm.insert(rolesTable).values({ name, rules: JSON.stringify(normalizeLegacyRules(rules)), updated_by: "config", updated_at: now }).onConflictDoNothing();
  }
  await orm.insert(meta).values({ key: "roles_imported", value: String(now) }).onConflictDoNothing();
  console.warn(`vibe-cms: copied ${Object.keys(configured).length} role(s) from permissions.roles into the site's database. Roles are edited in the editor now: remove "permissions" from your config.`);
}

interface RoleState {
  config: AnyConfig,
  db: D1,
  roles: RoleStore,
  org?: { current(): Promise<string | null> }
}

/** Who may edit roles: owners (the hub's site admins are owners) and `all` roles. */
export function canManageRoles(state: RoleState, session: Session | null): boolean {
  if(!session || session.readOnly) return false;
  if(session.sub === "dev" || session.roles.includes(OWNER_ROLE)) return true;
  return session.roles.some(role => state.roles.map[role]?.all === true);
}

function requireManager(state: RoleState, session: Session | null): Session {
  if(!session) throw new HttpError(401, "Sign in required");
  if(!canManageRoles(state, session)) throw new HttpError(403, "Only owners can change roles");
  return session;
}

export function listRoles(state: RoleState, session: Session | null) {
  if(!session) throw new HttpError(401, "Sign in required");
  const schema = roleSchema(state.config);
  return {
    roles: state.roles.list.map(role => ({ ...role, stale: staleKeys(role.rules, schema) })),
    canEdit: canManageRoles(state, session)
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
  // Only owners and `all` roles edit roles, and both already hold everything a role can grant.
  const current = state.roles.map[name];
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
  requireManager(state, session);
  if(!state.roles.map[name]) throw new HttpError(404, `No role called ${name}`);
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

/** Remembers who the hub signed in, and as what, for the Users page of org sites. */
export async function recordHubUser(db: D1, session: Session, siteAdmin: boolean): Promise<void> {
  const values = { sub: session.sub, email: session.email ?? null, name: session.name ?? null, roles: JSON.stringify(session.roles.filter(role => role !== OWNER_ROLE || !siteAdmin)), site_admin: siteAdmin, last_sign_in_at: Date.now() };
  await createDb(db).insert(hubUsers).values(values).onConflictDoUpdate({ target: hubUsers.sub, set: values });
}

export async function listHubUsers(db: D1) {
  const rows = await createDb(db).select().from(hubUsers).orderBy(hubUsers.email);
  return rows.map(row => ({
    sub: row.sub,
    email: row.email,
    name: row.name,
    roles: JSON.parse(row.roles) as string[],
    siteAdmin: row.site_admin,
    lastSignInAt: row.last_sign_in_at
  }));
}
