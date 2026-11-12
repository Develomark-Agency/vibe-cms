import { jwtVerify, SignJWT } from "jose";
import { HttpError, type Action, type AnyConfig, type RoleRules } from "../config.ts";
import type { Session } from "../server/index.ts";
import type { EngineState } from "./engine.ts";
import { eq, lt } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { codes } from "../db/schema.ts";
import { getMeta, getOrCreateMeta, randomToken } from "./db.ts";
import type { D1 } from "./platform.ts";
import type { RoleStore } from "./roles.ts";

/** What permission checks read: the config's types and locales, and the site's stored roles. */
export interface Access {
  config: AnyConfig,
  roles: Pick<RoleStore, "map">
}

const SESSION_TTL = 12 * 60 * 60;
/** Sessions the hub vouched for: renewed through the hub this often, so its grants are checked again. */
const HUB_SESSION_TTL = 10 * 60;
const CODE_TTL = 30;

export const DEV_SESSION: Session = { sub: "dev", name: "Local developer", email: "dev@localhost", roles: ["dev"] };

const keys = new WeakMap<D1, Promise<Uint8Array>>();

function sessionKey(db: D1): Promise<Uint8Array> {
  let key = keys.get(db);
  if(!key) {
    key = getOrCreateMeta(db, "session_secret", () => randomToken(48))
      .then(secret => new TextEncoder().encode(secret));
    key.catch(() => keys.delete(db));
    keys.set(db, key);
  }
  return key;
}

/** HMAC-SHA256 of `value` under the site's secret, hex: signs links that work without a session, like backup transfers. */
export async function signValue(db: D1, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", (await sessionKey(db)) as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return [...mac].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Issues a site session token. The site is both issuer and audience. */
export async function issueSession(db: D1, session: Session, siteId: string, origin: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + (session.hubOrg ? HUB_SESSION_TTL : SESSION_TTL);
  const token = await new SignJWT({ email: session.email, name: session.name, roles: session.roles, ...(session.hubOrg ? { hubOrg: session.hubOrg } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(origin)
    .setAudience(siteId)
    .setSubject(session.sub)
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(await sessionKey(db));
  return { token, expiresAt };
}

export async function verifySession(db: D1, token: string, siteId: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, await sessionKey(db), { audience: siteId, algorithms: ["HS256"] });
    return {
      sub: payload.sub!,
      email: payload.email as string | undefined,
      name: payload.name as string | undefined,
      roles: (payload.roles as string[] | undefined) ?? [],
      ...(typeof payload.hubOrg === "string" ? { hubOrg: payload.hubOrg } : {})
    };
  } catch {
    return null;
  }
}

// --- Hub tokens -----------------------------------------------------------

/** Where the site keeps whether its hub may back it up. Not in the `site` settings, so a restore never changes it. */
export const BACKUP_ACCESS_KEY = "backup_access";

/** Whether the site's hub may take and restore snapshots as itself. Off until an owner (or a role with `manageScheduledBackups`) turns it on. */
export async function backupAccess(db: D1): Promise<boolean> {
  return (await getMeta(db, BACKUP_ACCESS_KEY)) === "1";
}

/** The claims a hub token carries besides identity; everything else is the provider's, passed through. */
const RESERVED = new Set(["iss", "aud", "exp", "iat", "nbf", "jti", "scope"]);

/**
 * A token the hub of the site's org (`VIBE_ORG`) signed for this site: a user, whose roles the site
 * works out here, or with `scope: "backups"` the hub itself, which may only run backup actions and
 * only when someone turned scheduled backups on for the site (`site.setBackupAccess`). Null when it isn't one.
 */
export async function sessionFromHubToken(state: Pick<EngineState, "config" | "db" | "org" | "siteId" | "roles">, token: string): Promise<Session | null> {
  const payload = await state.org.verify(token, state.siteId);
  if(!payload) return null;
  if(payload.scope === "backups") {
    if(!await backupAccess(state.db)) return null;
    return { sub: `hub|${payload.iss}`, name: "Backups", roles: [], grants: ["backups"] };
  }
  if(payload.scope !== undefined) return null;
  if(typeof payload.sub !== "string" || !payload.sub) return null;
  const { siteAdmin, ...claims } = Object.fromEntries(Object.entries(payload).filter(([key]) => !RESERVED.has(key)));
  // The hub's signed grant: its owner and admins, and whoever added the site, manage it as owners.
  // Only ever from a verified hub token, never stored, and gone once the site stops trusting the hub.
  return { ...identitySession(state, payload.sub, claims, [], siteAdmin === true), hubOrg: payload.iss! };
}

/**
 * Built in: every permission, plus managing roles and who may sign in. Given by a site that signs people
 * in itself, or by the hub's signed `siteAdmin` claim; never by a `roles` claim.
 */
export const OWNER = "owner";

/**
 * Maps a provider identity (`<issuer>|<sub>`) and its claims to this site's roles: the `roles` claim
 * (the hub fills it from its own assignments and the identity provider claim in its `OIDC_ROLES_CLAIM`),
 * and the site's own assignments. Names that aren't stored roles are dropped.
 */
export function identitySession(access: Access, sub: string, claims: Record<string, unknown>, siteRoles: string[] = [], siteAdmin = false): Session {
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const verifiedEmail = email && claims.email_verified === true ? email.toLowerCase() : undefined;
  const roles = new Set<string>();
  const claim = claims.roles;
  // An identity provider group that happens to be called "owner" mustn't make someone owner everywhere.
  for(const role of Array.isArray(claim) ? claim : typeof claim === "string" ? [claim] : []) if(String(role) !== OWNER) roles.add(String(role));
  for(const role of siteRoles) roles.add(role);
  if(siteAdmin) roles.add(OWNER);
  const known = new Set([OWNER, ...Object.keys(access.roles.map)]);
  const granted = [...roles].filter(role => known.has(role));
  if(granted.length === 0) throw new HttpError(403, "No access to this site");
  return {
    sub,
    email: verifiedEmail ?? email,
    name: typeof claims.name === "string" ? claims.name : undefined,
    roles: granted
  };
}

export async function createCode(db: D1, session: Session): Promise<string> {
  const code = randomToken(24);
  const orm = createDb(db);
  await orm.delete(codes).where(lt(codes.expires_at, Date.now()));
  await orm.insert(codes).values({ code, payload: JSON.stringify(session), expires_at: Date.now() + CODE_TTL * 1000 });
  return code;
}

/** Single use: the row is deleted as it is read. */
export async function consumeCode(db: D1, code: string): Promise<Session> {
  const [row] = await createDb(db).delete(codes).where(eq(codes.code, code)).returning({ payload: codes.payload, expires_at: codes.expires_at });
  if(!row || row.expires_at < Date.now()) throw new HttpError(401, "Invalid or expired code");
  return JSON.parse(row.payload) as Session;
}

// --- Permissions -------------------------------------------------------------

export interface Permit {
  action: Action,
  type?: string,
  locale?: string,
  /**
   * `"media"` for the asset library, `"site"` for the site's name, accent and icon, `"backups"` for taking
   * and restoring backups, `"users"` for who may sign in to a site without an org (owners and `all` roles),
   * `"activity"` for seeing everyone's activity (`viewActivity`), `"redirects"` for the site's redirects
   * (`manageRedirects`), `"trash"` for how long deleted
   * items are kept (`manageTrash`) and `"activityRetention"` for how long activity is kept (`manageActivity`),
   * `"scheduledBackups"` for letting the hub back the site up (`manageScheduledBackups`).
   */
  scope?: "content" | "media" | "site" | "backups" | "users" | "activity" | "redirects" | "trash" | "activityRetention" | "scheduledBackups"
}

export function can(access: Access, session: Session | null, permit: Permit): boolean {
  if(!session) return false;
  if(session.readOnly && permit.action !== "read") return false;
  if(session.sub === "dev") return true;
  if(session.roles.includes(OWNER)) return true;
  if(permit.scope === "backups" && session.grants?.includes("backups")) return true;
  const roles = access.roles.map;
  return session.roles.some(name => {
    const rules = roles[name];
    return rules ? allows(rules, permit) : false;
  });
}

function allows(rules: RoleRules, { action, type, locale, scope }: Permit): boolean {
  if(rules.all) return true;
  // Who may sign in, and as what: role managers too, limited to roles within their own (signin.ts).
  if(scope === "users") return rules.manageRoles === true;
  if(scope === "site") return rules.siteSettings === true;
  if(scope === "activity") return rules.viewActivity === true;
  if(scope === "redirects") return rules.manageRedirects === true;
  if(scope === "trash") return rules.manageTrash === true;
  if(scope === "activityRetention") return rules.manageActivity === true;
  if(scope === "scheduledBackups") return rules.manageScheduledBackups === true;
  // Restoring (`write`) needs `true`; taking a snapshot (`read`) also `"take"`.
  if(scope === "backups") return rules.backups === true || (rules.backups === "take" && action === "read");
  if(scope === "media") {
    if(rules.media) return rules.media.includes(action);
    return action === "read" || hasAnyWrite(rules);
  }
  const typeRules = (type && Array.isArray(rules[type]) ? rules[type] : rules["*"]) as Action[] | undefined;
  if(!typeRules?.length) return false;
  if(action === "read") return true;
  let allowed: boolean;
  if(action === "publish") {
    allowed = rules.publish !== false && typeRules.includes("publish");
  } else if(action === "write") {
    // `write: { locales }` grants writing (translating) any readable type in those locales.
    allowed = typeRules.includes("write") || Boolean(rules.write);
  } else {
    allowed = typeRules.includes(action);
  }
  if(allowed && locale && rules.write?.locales && action !== "delete") return rules.write.locales.includes(locale);
  return allowed;
}

function hasAnyWrite(rules: RoleRules): boolean {
  return Object.values(rules).some(rule => Array.isArray(rule) && rule.includes("write"));
}

export function require(access: Access, session: Session | null, permit: Permit): Session {
  if(!session) throw new HttpError(401, "Sign in required");
  if(!can(access, session, permit)) {
    if(permit.scope === "backups") throw new HttpError(403, "Not allowed to take or restore backups");
    throw new HttpError(403, `Not allowed to ${permit.action} ${permit.scope === "media" ? "media" : permit.type ?? "content"}`);
  }
  return session;
}

/** What the editor needs to know to show or hide controls. */
export function permissionSummary(access: Access, session: Session) {
  const { config } = access;
  const types: Record<string, Record<Action, boolean>> = {};
  for(const type of Object.keys(config.schemas)) {
    types[type] = {
      read: can(access, session, { action: "read", type }),
      write: can(access, session, { action: "write", type }),
      publish: can(access, session, { action: "publish", type }),
      delete: can(access, session, { action: "delete", type })
    };
  }
  const writeLocales = (config.locales ?? []).filter(locale => Object.keys(config.schemas).some(type => can(access, session, { action: "write", type, locale })));
  return {
    types,
    media: {
      read: can(access, session, { action: "read", scope: "media" }),
      write: can(access, session, { action: "write", scope: "media" }),
      delete: can(access, session, { action: "delete", scope: "media" })
    },
    locales: writeLocales,
    site: can(access, session, { action: "write", scope: "site" }),
    users: can(access, session, { action: "write", scope: "users" }),
    activity: can(access, session, { action: "read", scope: "activity" }),
    redirects: can(access, session, { action: "write", scope: "redirects" }),
    trash: can(access, session, { action: "write", scope: "trash" }),
    activityRetention: can(access, session, { action: "write", scope: "activityRetention" }),
    scheduledBackups: can(access, session, { action: "write", scope: "scheduledBackups" }),
    roles: session.sub === "dev" || session.roles.includes(OWNER) || session.roles.some(role => access.roles.map[role]?.all === true || access.roles.map[role]?.manageRoles === true)
  };
}
