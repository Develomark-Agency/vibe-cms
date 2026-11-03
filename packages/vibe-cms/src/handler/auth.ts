import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload } from "jose";
import { HttpError, type Action, type AnyConfig, type RoleRules } from "../config.ts";
import type { Session } from "../server/index.ts";
import { first, getOrCreateMeta, randomToken, run } from "./db.ts";
import type { D1 } from "./platform.ts";

const SESSION_TTL = 12 * 60 * 60;
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
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const token = await new SignJWT({ email: session.email, name: session.name, roles: session.roles })
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
      roles: (payload.roles as string[] | undefined) ?? []
    };
  } catch {
    return null;
  }
}

// --- Panel backups ---------------------------------------------------------

const panelKeys = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * A backup token from the panel the config's `backups.panel` names: signed with the panel's
 * key, for this site, with the `backups` scope. Its session may only run backup actions.
 */
export async function sessionFromPanelToken(config: AnyConfig, token: string, siteId: string): Promise<Session | null> {
  const panel = config.backups?.panel?.replace(/\/$/, "");
  if(!panel) return null;
  let jwks = panelKeys.get(panel);
  if(!jwks) {
    jwks = createRemoteJWKSet(new URL(`${panel}/.well-known/jwks.json`));
    panelKeys.set(panel, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: panel, audience: siteId, algorithms: ["ES256"] });
    if(payload.scope !== "backups") return null;
    return { sub: `panel|${panel}`, name: "Backups", roles: [], grants: ["backups"] };
  } catch {
    return null;
  }
}

// --- OIDC ------------------------------------------------------------------

interface Discovery {
  issuer: string,
  jwks_uri: string
}

const discoveries = new Map<string, { at: number, jwks: ReturnType<typeof createRemoteJWKSet>, doc: Discovery }>();

async function discover(issuer: string) {
  const cached = discoveries.get(issuer);
  if(cached && Date.now() - cached.at < 60 * 60 * 1000) return cached;
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if(!response.ok) throw new HttpError(502, `OIDC discovery failed for ${issuer} (${response.status})`);
  const doc = await response.json() as Discovery;
  const entry = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  discoveries.set(issuer, entry);
  return entry;
}

/** Verifies a provider ID token against the site's trusted issuer and maps it to a session. */
export async function sessionFromIdToken(config: AnyConfig, idToken: string): Promise<Session> {
  const auth = config.auth;
  if(!auth) throw new HttpError(501, "This site has no `auth` configured");
  const { jwks, doc } = await discover(auth.issuer);
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwks, { issuer: doc.issuer, audience: auth.clientId }));
  } catch (error) {
    throw new HttpError(401, `Invalid ID token: ${(error as Error).message}`);
  }
  const sub = `${payload.iss}|${payload.sub}`;
  const email = typeof payload.email === "string" ? payload.email : undefined;
  const verifiedEmail = email && payload.email_verified === true ? email.toLowerCase() : undefined;
  const roles = new Set<string>();
  if(auth.roles) {
    const claim = payload[auth.roles];
    for(const role of Array.isArray(claim) ? claim : typeof claim === "string" ? [claim] : []) roles.add(String(role));
  }
  const users = config.permissions?.users ?? {};
  for(const key of [sub, verifiedEmail]) {
    for(const role of (key && users[key]) || []) roles.add(role);
  }
  const known = new Set(Object.keys(config.permissions?.roles ?? {}));
  const granted = [...roles].filter(role => known.has(role));
  if(granted.length === 0) throw new HttpError(403, "No access to this site");
  return {
    sub,
    email: verifiedEmail ?? email,
    name: typeof payload.name === "string" ? payload.name : undefined,
    roles: granted
  };
}

export async function createCode(db: D1, session: Session): Promise<string> {
  const code = randomToken(24);
  await run(db, "DELETE FROM vibe_codes WHERE expires_at < ?", [Date.now()]);
  await run(db, "INSERT INTO vibe_codes (code, payload, expires_at) VALUES (?, ?, ?)", [
    code,
    JSON.stringify(session),
    Date.now() + CODE_TTL * 1000
  ]);
  return code;
}

/** Single use: the row is deleted as it is read. */
export async function consumeCode(db: D1, code: string): Promise<Session> {
  const row = await first<{ payload: string, expires_at: number }>(
    db,
    "DELETE FROM vibe_codes WHERE code = ? RETURNING payload, expires_at",
    [code]
  );
  if(!row || row.expires_at < Date.now()) throw new HttpError(401, "Invalid or expired code");
  return JSON.parse(row.payload) as Session;
}

// --- Permissions -------------------------------------------------------------

export interface Permit {
  action: Action,
  type?: string,
  locale?: string,
  /** `"media"` for the asset library, `"site"` for the site's name, accent and icon, `"backups"` for taking and restoring backups. */
  scope?: "content" | "media" | "site" | "backups"
}

export function can(config: AnyConfig, session: Session | null, permit: Permit): boolean {
  if(!session) return false;
  if(session.sub === "dev") return true;
  if(permit.scope === "backups" && session.grants?.includes("backups")) return true;
  const roles = config.permissions?.roles ?? {};
  return session.roles.some(name => {
    const rules = roles[name];
    return rules ? allows(rules, permit) : false;
  });
}

function allows(rules: RoleRules, { action, type, locale, scope }: Permit): boolean {
  if(rules.all) return true;
  if(scope === "site") return rules.siteSettings === true;
  if(scope === "backups") return rules.backups === true;
  if(scope === "media") {
    if(rules.media) return rules.media.includes(action);
    return action === "read" || hasAnyWrite(rules);
  }
  const typeRules = (type && Array.isArray(rules[type]) ? rules[type] : rules["*"]) as Action[] | undefined;
  if(!typeRules?.length) return false;
  if(action === "read") return true;
  let allowed: boolean;
  if(action === "publish") {
    allowed = rules.publish ?? (typeRules.includes("write") || typeRules.includes("publish"));
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

export function require(config: AnyConfig, session: Session | null, permit: Permit): Session {
  if(!session) throw new HttpError(401, "Sign in required");
  if(!can(config, session, permit)) {
    if(permit.scope === "backups") throw new HttpError(403, "Not allowed to take or restore backups");
    throw new HttpError(403, `Not allowed to ${permit.action} ${permit.scope === "media" ? "media" : permit.type ?? "content"}`);
  }
  return session;
}

/** What the editor needs to know to show or hide controls. */
export function permissionSummary(config: AnyConfig, session: Session) {
  const types: Record<string, Record<Action, boolean>> = {};
  for(const type of Object.keys(config.schemas)) {
    types[type] = {
      read: can(config, session, { action: "read", type }),
      write: can(config, session, { action: "write", type }),
      publish: can(config, session, { action: "publish", type }),
      delete: can(config, session, { action: "delete", type })
    };
  }
  const writeLocales = (config.locales ?? []).filter(locale => Object.keys(config.schemas).some(type => can(config, session, { action: "write", type, locale })));
  return {
    types,
    media: {
      read: can(config, session, { action: "read", scope: "media" }),
      write: can(config, session, { action: "write", scope: "media" }),
      delete: can(config, session, { action: "delete", scope: "media" })
    },
    locales: writeLocales,
    site: can(config, session, { action: "write", scope: "site" })
  };
}
