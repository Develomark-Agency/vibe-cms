import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { PanelError, type PanelSite } from "vibe-cms/panel";
import type { RoleRules } from "vibe-cms";
import { describeRules } from "vibe-cms/roles";
import { adminToken, apiBase, hubOrigin } from "./hub.ts";
import * as t from "./schema.ts";
import { db, type Env, type SessionRow } from "./shared.ts";
import { randomString } from "./oidc.ts";

/**
 * Who administers what on the hub: its members and their hub roles, who may manage each site, the
 * hub's site role assignments, and templates of roles copied onto new sites.
 *
 * Sites still decide what roles mean; the hub only names roles (in the token's `roles` claim) and
 * vouches for site admins (the signed `siteAdmin` claim).
 */

export const HUB_PERMISSIONS = ["members", "templates", "addSites", "removeSites"] as const;
export type HubPermission = typeof HUB_PERMISSIONS[number];

/** Built-in hub roles; custom ones live in `hub_roles`. */
export const OWNER = "owner";
export const ADMIN = "admin";
export const MEMBER = "member";
const BUILT_IN = new Set([OWNER, ADMIN, MEMBER]);

export interface HubAccess {
  sub: string,
  member: t.MemberRow | null,
  role: string | null,
  permissions: HubPermission[],
  /** The hub's owner or an admin: sees and manages every site. */
  admin: boolean,
  owner: boolean
}

function now() {
  return Date.now();
}

function newId(prefix: string) {
  return `${prefix}_${randomString(12)}`;
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new PanelError(400, "Expected an email address");
  return email;
}

// --- Bootstrap -------------------------------------------------------------------

export async function hasOwner(env: Env): Promise<boolean> {
  const [row] = await db(env).select({ id: t.members.id }).from(t.members).where(eq(t.members.role, OWNER)).limit(1);
  return Boolean(row);
}

async function meta(env: Env, key: string): Promise<string | null> {
  const [row] = await db(env).select({ value: t.panelMeta.value }).from(t.panelMeta).where(eq(t.panelMeta.key, key));
  return row?.value ?? null;
}

/** The one-time setup token, made on first use and kept until someone claims the hub. */
export async function setupToken(env: Env): Promise<string> {
  const existing = await meta(env, "setup_token");
  if(existing) return existing;
  await db(env).insert(t.panelMeta).values({ key: "setup_token", value: randomString(24) }).onConflictDoNothing();
  return (await meta(env, "setup_token"))!;
}

let announced = false;

/**
 * While the hub has no owner, prints a one-time setup link to its logs (`wrangler tail`). Whoever opens
 * it and signs in becomes the owner; nobody else can sign in until then.
 */
export async function announceSetup(env: Env, origin: string) {
  if(announced || await hasOwner(env)) return;
  announced = true;
  const token = await setupToken(env);
  const base = await hubOrigin(env) ?? origin;
  console.log(`vibe-panel: this panel has no owner yet. Open this link and sign in to become its owner (it works once):\n  ${base}/#setup=${token}`);
}

/**
 * Runs at every sign-in, after `PANEL_ALLOW`. Claims the hub with the setup token while it has no
 * owner, and turns invites and assignments made by email into ones for this `sub`. Returns why the
 * sign-in is refused, or null.
 */
export async function admitSignIn(env: Env, identity: { sub: string, email?: string, emailVerified: boolean, name?: string }, setup: string | null): Promise<string | null> {
  const orm = db(env);
  if(!await hasOwner(env)) {
    const stored = await meta(env, "setup_token");
    if(!setup || !stored || setup !== stored) return "This panel has no owner yet. Open the setup link from the panel's logs to claim it.";
    const [existing] = await orm.select().from(t.members).where(eq(t.members.sub, identity.sub));
    if(existing) await orm.update(t.members).set({ role: OWNER }).where(eq(t.members.id, existing.id));
    else await orm.insert(t.members).values({ id: newId("mem"), sub: identity.sub, email: identity.email?.toLowerCase() ?? null, name: identity.name ?? null, role: OWNER, added_by: "setup", added_at: now() });
    await orm.delete(t.panelMeta).where(eq(t.panelMeta.key, "setup_token"));
    announced = false;
  }
  const email = identity.emailVerified ? identity.email?.toLowerCase() : undefined;
  const [member] = await orm.select().from(t.members).where(eq(t.members.sub, identity.sub));
  if(member) {
    await orm.update(t.members).set({ last_seen_at: now(), name: identity.name ?? member.name, email: email ?? member.email }).where(eq(t.members.id, member.id));
  } else if(email) {
    // An invite by email becomes this person's membership.
    const [invite] = await orm.select().from(t.members).where(and(isNull(t.members.sub), eq(t.members.email, email))).limit(1);
    if(invite) await orm.update(t.members).set({ sub: identity.sub, name: identity.name ?? invite.name, last_seen_at: now() }).where(eq(t.members.id, invite.id));
  }
  if(email) {
    const pending = await orm.select().from(t.siteAssignments).where(eq(t.siteAssignments.principal, `email:${email}`));
    for(const row of pending) {
      await orm.insert(t.siteAssignments)
        .values({ ...row, principal: identity.sub, name: identity.name ?? row.name })
        .onConflictDoUpdate({ target: [t.siteAssignments.site_id, t.siteAssignments.principal], set: { roles: row.roles } });
      await orm.delete(t.siteAssignments).where(and(eq(t.siteAssignments.site_id, row.site_id), eq(t.siteAssignments.principal, row.principal)));
    }
  }
  return null;
}

// --- Hub roles and permissions ------------------------------------------------------

async function rolePermissions(env: Env, role: string | null): Promise<HubPermission[]> {
  if(role === OWNER || role === ADMIN) return [...HUB_PERMISSIONS];
  if(!role || role === MEMBER) return [];
  const [row] = await db(env).select().from(t.hubRoles).where(eq(t.hubRoles.name, role));
  if(!row) return [];
  return (JSON.parse(row.permissions) as string[]).filter((p): p is HubPermission => (HUB_PERMISSIONS as readonly string[]).includes(p));
}

export async function hubAccess(env: Env, session: SessionRow): Promise<HubAccess> {
  const [member] = await db(env).select().from(t.members).where(eq(t.members.sub, session.sub));
  const role = member?.role ?? null;
  return {
    sub: session.sub,
    member: member ?? null,
    role,
    permissions: await rolePermissions(env, role),
    admin: role === OWNER || role === ADMIN,
    owner: role === OWNER
  };
}

export function requirePermission(access: HubAccess, permission: HubPermission) {
  if(!access.permissions.includes(permission)) throw new PanelError(403, "You don't have permission to do that on this panel");
}

export async function listHubRoles(env: Env) {
  const rows = await db(env).select().from(t.hubRoles).orderBy(t.hubRoles.name);
  return [
    { name: OWNER, permissions: [...HUB_PERMISSIONS], builtIn: true },
    { name: ADMIN, permissions: [...HUB_PERMISSIONS], builtIn: true },
    { name: MEMBER, permissions: [] as HubPermission[], builtIn: true },
    ...rows.map(row => ({ name: row.name, permissions: JSON.parse(row.permissions) as HubPermission[], builtIn: false }))
  ];
}

export async function saveHubRole(env: Env, access: HubAccess, name: string, permissions: unknown) {
  requirePermission(access, "members");
  if(BUILT_IN.has(name)) throw new PanelError(400, `${name} is built in`);
  if(!/^[a-z][a-z0-9 _-]{0,39}$/i.test(name)) throw new PanelError(400, "Role names are letters, digits, spaces, - and _, up to 40 characters");
  if(!Array.isArray(permissions) || permissions.some(p => !(HUB_PERMISSIONS as readonly string[]).includes(p))) {
    throw new PanelError(400, `Permissions are any of ${HUB_PERMISSIONS.join(", ")}`);
  }
  const value = JSON.stringify([...new Set(permissions as string[])]);
  await db(env).insert(t.hubRoles).values({ name, permissions: value, updated_by: access.sub, updated_at: now() })
    .onConflictDoUpdate({ target: t.hubRoles.name, set: { permissions: value, updated_by: access.sub, updated_at: now() } });
}

export async function deleteHubRole(env: Env, access: HubAccess, name: string) {
  requirePermission(access, "members");
  if(BUILT_IN.has(name)) throw new PanelError(400, `${name} is built in`);
  const [used] = await db(env).select({ id: t.members.id }).from(t.members).where(eq(t.members.role, name)).limit(1);
  if(used) throw new PanelError(409, "Some people still have this role. Give them another one first.");
  await db(env).delete(t.hubRoles).where(eq(t.hubRoles.name, name));
}

async function checkRole(env: Env, role: unknown): Promise<string> {
  if(typeof role !== "string" || !role) throw new PanelError(400, "Expected a hub role");
  if(BUILT_IN.has(role)) return role;
  const [row] = await db(env).select({ name: t.hubRoles.name }).from(t.hubRoles).where(eq(t.hubRoles.name, role));
  if(!row) throw new PanelError(400, `Unknown hub role: ${role}`);
  return role;
}

// --- Members ---------------------------------------------------------------------

export async function listMembers(env: Env) {
  const orm = db(env);
  const [rows, grants, assignments, siteCount] = await Promise.all([
    orm.select().from(t.members).orderBy(t.members.added_at),
    orm.select({ sub: t.siteGrants.sub, n: sql<number>`count(*)` }).from(t.siteGrants).groupBy(t.siteGrants.sub),
    orm.select({ principal: t.siteAssignments.principal, site: t.sites.name }).from(t.siteAssignments).innerJoin(t.sites, eq(t.sites.id, t.siteAssignments.site_id)),
    orm.select({ n: sql<number>`count(*)` }).from(t.sites)
  ]);
  const granted = new Map(grants.map(g => [g.sub, g.n]));
  return {
    sites: siteCount[0]?.n ?? 0,
    members: rows.map(row => {
      const keys = [row.sub, row.email && `email:${row.email}`].filter(Boolean);
      return {
        id: row.id,
        sub: row.sub,
        email: row.email,
        name: row.name,
        role: row.role,
        invited: !row.sub,
        addedAt: row.added_at,
        lastSeenAt: row.last_seen_at,
        managedSites: row.sub ? granted.get(row.sub) ?? 0 : 0,
        assignedSites: assignments.filter(a => keys.includes(a.principal)).map(a => a.site)
      };
    })
  };
}

export async function inviteMember(env: Env, access: HubAccess, input: { email?: unknown, role?: unknown }) {
  requirePermission(access, "members");
  const email = normalizeEmail(input.email);
  const role = await checkRole(env, input.role ?? MEMBER);
  if(role === OWNER) throw new PanelError(400, "There's one owner. Make them an admin instead.");
  const [existing] = await db(env).select().from(t.members).where(eq(t.members.email, email)).limit(1);
  if(existing) {
    if(existing.role === OWNER) throw new PanelError(409, "That's the owner");
    await db(env).update(t.members).set({ role }).where(eq(t.members.id, existing.id));
    return { id: existing.id, email, role };
  }
  const id = newId("mem");
  await db(env).insert(t.members).values({ id, sub: null, email, name: null, role, added_by: access.sub, added_at: now() });
  return { id, email, role };
}

async function memberById(env: Env, id: string): Promise<t.MemberRow> {
  const [row] = await db(env).select().from(t.members).where(eq(t.members.id, id));
  if(!row) throw new PanelError(404, "No such member");
  return row;
}

export async function updateMember(env: Env, access: HubAccess, id: string, input: { role?: unknown }) {
  requirePermission(access, "members");
  const member = await memberById(env, id);
  const role = await checkRole(env, input.role);
  // The owner can't be demoted by anyone else, and nobody else can be made owner.
  if(member.role === OWNER) throw new PanelError(403, "The owner's role can't be changed");
  if(role === OWNER) {
    if(!access.owner) throw new PanelError(403, "Only the owner can hand the panel over");
    // Handing over: the old owner becomes an admin.
    await db(env).update(t.members).set({ role: ADMIN }).where(eq(t.members.sub, access.sub));
  }
  if((role === ADMIN || member.role === ADMIN) && !access.admin) throw new PanelError(403, "Only the owner and admins can change admins");
  await db(env).update(t.members).set({ role }).where(eq(t.members.id, id));
  return { id, role };
}

export async function removeMember(env: Env, access: HubAccess, id: string) {
  requirePermission(access, "members");
  const member = await memberById(env, id);
  if(member.role === OWNER) throw new PanelError(403, "The owner can't be removed");
  if(member.role === ADMIN && !access.admin) throw new PanelError(403, "Only the owner and admins can remove admins");
  const orm = db(env);
  await orm.delete(t.members).where(eq(t.members.id, id));
  if(member.sub) {
    await orm.delete(t.siteGrants).where(eq(t.siteGrants.sub, member.sub));
    await orm.delete(t.siteAssignments).where(eq(t.siteAssignments.principal, member.sub));
    // Signed out everywhere on the panel; site sessions run out on their own.
    await orm.delete(t.sessions).where(eq(t.sessions.sub, member.sub));
  }
  if(member.email) await orm.delete(t.siteAssignments).where(eq(t.siteAssignments.principal, `email:${member.email}`));
}

// --- Sites: who sees and manages them ------------------------------------------------------

/** The sites someone sees: all of them for owners and admins, else those they manage or have a role on. */
export async function visibleSiteIds(env: Env, access: HubAccess): Promise<Set<string> | "all"> {
  if(access.admin) return "all";
  const orm = db(env);
  const [grants, assignments] = await Promise.all([
    orm.select({ id: t.siteGrants.site_id }).from(t.siteGrants).where(eq(t.siteGrants.sub, access.sub)),
    orm.select({ id: t.siteAssignments.site_id }).from(t.siteAssignments).where(eq(t.siteAssignments.principal, access.sub))
  ]);
  return new Set([...grants, ...assignments].map(row => row.id));
}

export async function canSeeSite(env: Env, access: HubAccess, siteId: string): Promise<boolean> {
  const visible = await visibleSiteIds(env, access);
  return visible === "all" || visible.has(siteId);
}

/** Owners and admins, and whoever holds a grant for the site (its adder). */
export async function canManageSite(env: Env, access: HubAccess, siteId: string): Promise<boolean> {
  if(access.admin) return true;
  const [grant] = await db(env).select({ sub: t.siteGrants.sub }).from(t.siteGrants).where(and(eq(t.siteGrants.site_id, siteId), eq(t.siteGrants.sub, access.sub)));
  return Boolean(grant);
}

export async function requireSiteManager(env: Env, access: HubAccess, siteId: string) {
  if(!await canManageSite(env, access, siteId)) throw new PanelError(403, "Only this site's owners can do that");
}

export async function requireVisibleSite(env: Env, access: HubAccess, siteId: string) {
  if(!await canSeeSite(env, access, siteId)) throw new PanelError(404, "Unknown site");
}

/**
 * What the hub tells a site about someone, besides who they are: the roles it assigned them there, and
 * whether they manage the site (`siteAdmin`).
 */
export async function siteClaims(env: Env, sub: string, siteId: string): Promise<{ roles: string[], siteAdmin: boolean }> {
  const orm = db(env);
  const [member] = await orm.select({ role: t.members.role }).from(t.members).where(eq(t.members.sub, sub));
  const [grant] = await orm.select({ sub: t.siteGrants.sub }).from(t.siteGrants).where(and(eq(t.siteGrants.site_id, siteId), eq(t.siteGrants.sub, sub)));
  const [assignment] = await orm.select({ roles: t.siteAssignments.roles }).from(t.siteAssignments).where(and(eq(t.siteAssignments.site_id, siteId), eq(t.siteAssignments.principal, sub)));
  return {
    roles: assignment ? JSON.parse(assignment.roles) as string[] : [],
    siteAdmin: member?.role === OWNER || member?.role === ADMIN || Boolean(grant)
  };
}

/** A hub → site call to the site's role API, as `sub` with the site admin claim. */
async function siteRolesCall(env: Env, site: Pick<PanelSite, "id" | "admin">, sub: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await adminToken(env, sub, site.id)}`);
  if(init.body) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${apiBase(site)}/api${path}`, { ...init, headers });
  } catch {
    throw new PanelError(502, "The site couldn't be reached");
  }
  const data = await response.json().catch(() => ({})) as { error?: string };
  if(!response.ok) throw new PanelError(response.status === 404 ? 502 : response.status, data.error ?? `The site refused (${response.status})`);
  return data;
}

export interface SiteRole {
  name: string,
  rules: RoleRules,
  updatedBy: string | null,
  updatedAt: number | null,
  stale: string[]
}

/** A site's stored roles, read through its role API. */
export async function siteRoles(env: Env, site: Pick<PanelSite, "id" | "admin">, sub: string): Promise<SiteRole[]> {
  const data = await siteRolesCall(env, site, sub, "/roles") as { roles?: SiteRole[] };
  return data.roles ?? [];
}

export async function siteAccess(env: Env, access: HubAccess, site: PanelSite) {
  const orm = db(env);
  const [row] = await orm.select().from(t.sites).where(eq(t.sites.id, site.id));
  const [grants, admins, assignments, template] = await Promise.all([
    orm.select({ sub: t.siteGrants.sub, grantedAt: t.siteGrants.granted_at, grantedBy: t.siteGrants.granted_by, email: t.members.email, name: t.members.name })
      .from(t.siteGrants).leftJoin(t.members, eq(t.members.sub, t.siteGrants.sub)).where(eq(t.siteGrants.site_id, site.id)),
    orm.select().from(t.members).where(inArray(t.members.role, [OWNER, ADMIN])),
    orm.select().from(t.siteAssignments).where(eq(t.siteAssignments.site_id, site.id)),
    row?.template_id ? orm.select({ id: t.templates.id, name: t.templates.name }).from(t.templates).where(eq(t.templates.id, row.template_id)) : Promise.resolve([])
  ]);
  const manage = await canManageSite(env, access, site.id);
  let roles: SiteRole[] | null = null;
  let rolesError: string | null = null;
  if(manage) {
    try {
      roles = await siteRoles(env, site, access.sub);
    } catch (error) {
      rolesError = (error as Error).message;
    }
  }
  return {
    site: { ...site, addedBy: row?.added_by ?? null, addedAt: row?.added_at ?? null },
    canManage: manage,
    owners: [
      ...admins.filter(m => m.sub).map(m => ({ sub: m.sub!, email: m.email, name: m.name, kind: m.role as "owner" | "admin", grantedAt: null as number | null, adder: false })),
      ...grants.filter(g => !admins.some(m => m.sub === g.sub)).map(g => ({ sub: g.sub, email: g.email, name: g.name, kind: "grant" as const, grantedAt: g.grantedAt, adder: g.sub === row?.added_by }))
    ],
    people: assignments.map(a => ({
      principal: a.principal,
      email: a.email,
      name: a.name,
      invited: a.principal.startsWith("email:"),
      roles: JSON.parse(a.roles) as string[]
    })),
    roles,
    rolesError,
    template: row?.template_state ? {
      id: row.template_id,
      name: template[0]?.name ?? null,
      state: row.template_state,
      skipped: JSON.parse(row.template_skipped ?? "[]") as string[],
      error: row.template_error,
      attempts: row.template_attempts
    } : null
  };
}

/** Gives someone roles on a site, by email (resolved to their `sub` at sign-in) or by `sub`. */
export async function assign(env: Env, access: HubAccess, siteId: string, input: { email?: unknown, sub?: unknown, roles?: unknown }) {
  await requireSiteManager(env, access, siteId);
  if(!Array.isArray(input.roles) || input.roles.some(r => typeof r !== "string" || r === "owner")) throw new PanelError(400, "Expected roles as a list of the site's role names");
  const roles = [...new Set(input.roles as string[])];
  const orm = db(env);
  let principal: string;
  let email: string | null = null;
  let name: string | null = null;
  if(typeof input.sub === "string" && input.sub) {
    principal = input.sub;
    const [member] = await orm.select().from(t.members).where(eq(t.members.sub, principal));
    email = member?.email ?? null;
    name = member?.name ?? null;
  } else {
    email = normalizeEmail(input.email);
    const [member] = await orm.select().from(t.members).where(and(eq(t.members.email, email), sql`${t.members.sub} IS NOT NULL`)).limit(1);
    const [seen] = member ? [] : await orm.select({ sub: t.sessions.sub, name: t.sessions.name }).from(t.sessions).where(eq(t.sessions.email, email)).limit(1);
    principal = member?.sub ?? seen?.sub ?? `email:${email}`;
    name = member?.name ?? seen?.name ?? null;
  }
  if(roles.length === 0) {
    await orm.delete(t.siteAssignments).where(and(eq(t.siteAssignments.site_id, siteId), eq(t.siteAssignments.principal, principal)));
    return { principal, roles };
  }
  const value = JSON.stringify(roles);
  await orm.insert(t.siteAssignments)
    .values({ site_id: siteId, principal, email, name, roles: value, assigned_by: access.sub, assigned_at: now() })
    .onConflictDoUpdate({ target: [t.siteAssignments.site_id, t.siteAssignments.principal], set: { roles: value, assigned_by: access.sub, assigned_at: now() } });
  return { principal, roles };
}

export async function unassign(env: Env, access: HubAccess, siteId: string, principal: string) {
  await requireSiteManager(env, access, siteId);
  await db(env).delete(t.siteAssignments).where(and(eq(t.siteAssignments.site_id, siteId), eq(t.siteAssignments.principal, principal)));
}

/** Lets another member manage the site. Hub admins only: a site's adder can't hand it on. */
export async function grantSite(env: Env, access: HubAccess, siteId: string, sub: unknown) {
  if(!access.admin) throw new PanelError(403, "Only the panel's owner and admins can make someone a site owner");
  if(typeof sub !== "string" || !sub) throw new PanelError(400, "Expected sub");
  const [member] = await db(env).select({ id: t.members.id }).from(t.members).where(eq(t.members.sub, sub));
  if(!member) throw new PanelError(400, "Only members of the panel can own sites");
  await db(env).insert(t.siteGrants).values({ site_id: siteId, sub, kind: "owner", granted_by: access.sub, granted_at: now() }).onConflictDoNothing();
}

export async function revokeSite(env: Env, access: HubAccess, siteId: string, sub: string) {
  if(!access.admin) throw new PanelError(403, "Only the panel's owner and admins can change site owners");
  await db(env).delete(t.siteGrants).where(and(eq(t.siteGrants.site_id, siteId), eq(t.siteGrants.sub, sub)));
}

// --- Templates ---------------------------------------------------------------------

export interface TemplateView {
  id: string,
  name: string,
  roles: Record<string, RoleRules>,
  isDefault: boolean,
  updatedBy: string,
  updatedAt: number,
  usedBy: number,
  summary: Record<string, string>
}

function templateView(row: t.TemplateRow, usedBy: number): TemplateView {
  const roles = JSON.parse(row.roles) as Record<string, RoleRules>;
  return {
    id: row.id,
    name: row.name,
    roles,
    isDefault: row.is_default,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    usedBy,
    summary: Object.fromEntries(Object.entries(roles).map(([name, rules]) => [name, describeRules(rules)]))
  };
}

export async function listTemplates(env: Env): Promise<TemplateView[]> {
  const orm = db(env);
  const [rows, usage] = await Promise.all([
    orm.select().from(t.templates).orderBy(t.templates.name),
    orm.select({ id: t.sites.template_id, n: sql<number>`count(*)` }).from(t.sites).groupBy(t.sites.template_id)
  ]);
  const used = new Map(usage.map(u => [u.id, u.n]));
  return rows.map(row => templateView(row, used.get(row.id) ?? 0));
}

function checkTemplateRoles(roles: unknown): Record<string, RoleRules> {
  if(typeof roles !== "object" || roles === null || Array.isArray(roles)) throw new PanelError(400, "Expected roles as { name: rules }");
  for(const [name, rules] of Object.entries(roles)) {
    if(!/^[a-z][a-z0-9_-]{0,39}$/i.test(name) || name === "owner") throw new PanelError(400, `${name}: role names are letters, digits, - and _, and not owner`);
    if(typeof rules !== "object" || rules === null || Array.isArray(rules)) throw new PanelError(400, `${name}: rules must be an object`);
  }
  return roles as Record<string, RoleRules>;
}

export async function saveTemplate(env: Env, access: HubAccess, id: string | null, input: { name?: unknown, roles?: unknown, isDefault?: unknown }) {
  requirePermission(access, "templates");
  const orm = db(env);
  const existing = id ? (await orm.select().from(t.templates).where(eq(t.templates.id, id)))[0] : undefined;
  if(id && !existing) throw new PanelError(404, "No such template");
  const name = typeof input.name === "string" ? input.name.trim() : existing?.name;
  if(!name) throw new PanelError(400, "Give the template a name");
  const roles = input.roles === undefined && existing ? JSON.parse(existing.roles) : checkTemplateRoles(input.roles ?? {});
  const isDefault = typeof input.isDefault === "boolean" ? input.isDefault : existing?.is_default ?? false;
  const templateId = existing?.id ?? newId("tpl");
  if(isDefault) await orm.update(t.templates).set({ is_default: false });
  const values = { name, roles: JSON.stringify(roles), is_default: isDefault, updated_by: access.member?.name ?? access.member?.email ?? access.sub, updated_at: now() };
  await orm.insert(t.templates).values({ id: templateId, ...values }).onConflictDoUpdate({ target: t.templates.id, set: values });
  return (await listTemplates(env)).find(template => template.id === templateId)!;
}

export async function deleteTemplate(env: Env, access: HubAccess, id: string) {
  requirePermission(access, "templates");
  await db(env).delete(t.templates).where(eq(t.templates.id, id));
}

/**
 * Writes a template's roles onto a site through its role API, as `sub` with the site admin claim.
 * Rules for types the site lacks are skipped and reported. When the site can't be reached the apply
 * is left `pending` for the cron to retry.
 */
export async function applyTemplate(env: Env, site: Pick<PanelSite, "id" | "admin">, templateId: string, sub: string, replace = false) {
  const orm = db(env);
  const [template] = await orm.select().from(t.templates).where(eq(t.templates.id, templateId));
  if(!template) throw new PanelError(404, "No such template");
  const [row] = await orm.select({ attempts: t.sites.template_attempts, templateId: t.sites.template_id }).from(t.sites).where(eq(t.sites.id, site.id));
  const attempts = row?.templateId === templateId ? (row.attempts ?? 0) + 1 : 1;
  try {
    const result = await siteRolesCall(env, site, sub, "/roles/apply", { method: "POST", body: JSON.stringify({ roles: JSON.parse(template.roles), replace }) }) as { skipped: string[] };
    await orm.update(t.sites).set({ template_id: templateId, template_state: "applied", template_skipped: JSON.stringify(result.skipped ?? []), template_error: null, template_attempts: attempts, template_by: sub }).where(eq(t.sites.id, site.id));
    return { state: "applied" as const, skipped: result.skipped ?? [] };
  } catch (error) {
    const message = (error as Error).message;
    // Unreachable sites are retried; a site that refused the roles won't change its mind.
    const state: "pending" | "failed" = error instanceof PanelError && error.status === 502 && attempts < 10 ? "pending" : "failed";
    await orm.update(t.sites).set({ template_id: templateId, template_state: state, template_error: message, template_attempts: attempts, template_by: sub }).where(eq(t.sites.id, site.id));
    return { state, skipped: [] as string[], error: message };
  }
}

/** Cron: tries pending template applies again. */
export async function retryTemplates(env: Env) {
  const rows = await db(env).select().from(t.sites).where(and(eq(t.sites.template_state, "pending"), lt(t.sites.template_attempts, 10)));
  for(const row of rows) {
    if(!row.template_id) continue;
    await applyTemplate(env, row, row.template_id, row.template_by ?? row.added_by).catch(error => console.error("vibe-panel: template apply failed", error));
  }
}

export async function defaultTemplateId(env: Env): Promise<string | null> {
  const [row] = await db(env).select({ id: t.templates.id }).from(t.templates).where(eq(t.templates.is_default, true)).limit(1);
  return row?.id ?? null;
}

/** Records the adder as the site's owner on the hub. */
export async function grantAdder(env: Env, siteId: string, sub: string) {
  await db(env).insert(t.siteGrants).values({ site_id: siteId, sub, kind: "owner", granted_by: "added", granted_at: now() }).onConflictDoNothing();
}
