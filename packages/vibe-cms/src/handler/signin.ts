import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON
} from "@simplewebauthn/server";
import { HttpError } from "../config.ts";
import type { EmailSender } from "./email.ts";
import { authorizationUrl, exchangeCode, isAllowed, randomString, verifyIdToken, type OidcConfig } from "../oidc/index.ts";
import type { Session } from "../server/index.ts";
import { identitySession, OWNER } from "./auth.ts";
import { fullRoleManager, outOfReach } from "./roles.ts";
import { count, eq, getTableColumns, like, lt, or, sql } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { challenges, invites, meta, passkeys, signins, users } from "../db/schema.ts";
import { getMeta, newId, sha256 } from "./db.ts";
import type { EngineState } from "./engine.ts";

/**
 * Sign-in for a site that doesn't belong to an org (no `VIBE_ORG`). With `OIDC_ISSUER`,
 * `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, the site signs people in with that identity provider
 * itself; without them, with passkeys. Either way:
 *
 * - The first owner comes from a one-time setup link the site prints to its logs, never from
 *   whoever finds the site first.
 * - Owners invite people by email, with roles. The invite is emailed when the site has an `email`
 *   sender, and shown as a link to copy otherwise.
 * - A signed-in browser holds an httpOnly cookie that only `POST /api/session` reads, to hand the
 *   editor a session token. Every other route takes `Authorization: Bearer` only.
 */

export type SignInMode = "hub" | "oidc" | "passkey";

export interface SignInEnv {
  OIDC_ISSUER?: string,
  OIDC_CLIENT_ID?: string,
  OIDC_CLIENT_SECRET?: string,
  OIDC_SCOPES?: string,
  /** Identity provider claim whose values count as roles, e.g. `groups`. */
  OIDC_ROLES_CLAIM?: string,
  /** Who may sign in with the identity provider: email domains or group claim values. Empty allows anyone with a role. */
  VIBE_ALLOW?: string
}

export interface SignInConfig {
  oidc: (OidcConfig & { rolesClaim?: string, allow?: string }) | null,
  email: EmailSender | undefined
}

export function signInConfig(env: SignInEnv, email: EmailSender | undefined): SignInConfig {
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: clientSecret } = env;
  const some = issuer || clientId || clientSecret;
  if(some && !(issuer && clientId && clientSecret)) {
    throw new Error("vibe-cms: signing in with an identity provider needs all of OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET");
  }
  return {
    oidc: issuer && clientId && clientSecret
      ? { issuer, clientId, clientSecret, scopes: env.OIDC_SCOPES ?? "openid email profile", rolesClaim: env.OIDC_ROLES_CLAIM, allow: env.VIBE_ALLOW }
      : null,
    email
  };
}

export const SIGNIN_COOKIE = "vibe_signin";
const LOGIN_COOKIE = "vibe_login";
const SIGNIN_TTL = 30 * 24 * 3600 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const INVITE_TTL = 7 * 24 * 3600 * 1000;

type State = Pick<EngineState, "config" | "db" | "org" | "prefix" | "signIn" | "roles">;

export async function signInMode(state: State): Promise<SignInMode> {
  if(await state.org.current()) return "hub";
  return state.signIn.oidc ? "oidc" : "passkey";
}

/** Who signed in, as kept with a signed-in browser or a connected agent; roles are worked out again on every use. */
export interface Identity {
  sub: string,
  email?: string,
  emailVerified: boolean,
  name?: string,
  /** The identity provider's role claim values, when `OIDC_ROLES_CLAIM` names one. */
  claimRoles?: string[]
}

type UserRow = typeof users.$inferSelect;

/** Roles are a JSON array in a text column, so "is an owner" is a substring match. */
const ownerPattern = `%"${OWNER}"%`;

async function userBy(state: State, where: ReturnType<typeof eq>): Promise<UserRow | null> {
  const [row] = await createDb(state.db).select().from(users).where(where).limit(1);
  return row ?? null;
}

/**
 * A session for someone signed in by the site itself. Roles come from the config's
 * `permissions.users`, the identity provider's role claim, and the user's row (by verified email).
 */
export async function standaloneSession(state: State, identity: Identity): Promise<Session> {
  const email = identity.email?.toLowerCase();
  const user = email && identity.emailVerified ? await userBy(state, eq(users.email, email)) : null;
  return identitySession(state, identity.sub, {
    email: identity.email,
    email_verified: identity.emailVerified,
    name: identity.name ?? user?.name ?? undefined,
    roles: identity.claimRoles ?? []
  }, user ? JSON.parse(user.roles) as string[] : []);
}

// --- The first owner ----------------------------------------------------------------

/** Whether nobody owns the site yet, so the setup link works. */
export async function needsSetup(state: State): Promise<boolean> {
  if(await signInMode(state) === "hub") return false;
  const [owner] = await createDb(state.db).select({ id: users.id }).from(users).where(like(users.roles, ownerPattern)).limit(1);
  return !owner;
}

/** Sites (by database) whose setup link this isolate already printed. */
const announced = new WeakSet<object>();

/**
 * The setup link, made once and kept until someone uses it. The site prints it to its logs
 * (`wrangler tail`, or the dev server's output) while nobody owns the site.
 */
export async function announceSetup(state: State, origin: string) {
  if(announced.has(state.db) || !await needsSetup(state)) return;
  announced.add(state.db);
  let token = await getMeta(state.db, "setup_token");
  if(!token) {
    await createDb(state.db).insert(meta).values({ key: "setup_token", value: randomString(24) }).onConflictDoNothing();
    token = await getMeta(state.db, "setup_token");
  }
  console.log(`vibe-cms: nobody can sign in to this site yet. Open this link to become its owner (it works once):\n  ${origin}${state.prefix}/admin/#setup=${token}`);
}

/** Sites (by database) whose claim link this isolate already printed. */
const claimAnnounced = new WeakSet<object>();

/**
 * The other way a new site gets going: a hub claims it for its org, with this link (`vibe-cms admin
 * attach`, or the panel's "Add a site"). Printed beside the setup link, while nobody owns the site.
 */
export async function announceClaim(state: State, origin: string) {
  if(claimAnnounced.has(state.db) || !await needsSetup(state)) return;
  claimAnnounced.add(state.db);
  const token = await state.org.claimToken();
  if(!token) return;
  console.log(`vibe-cms: to attach this site to your org's panel instead, add it there with this claim link (\`vibe-cms admin attach\`, or the panel's "Add a site"); it works once:\n  ${origin}${state.prefix}/admin/#claim=${token}`);
}

async function checkSetupToken(state: State, token: string | undefined) {
  const stored = await getMeta(state.db, "setup_token");
  if(!token || !stored || token !== stored || !await needsSetup(state)) throw new HttpError(403, "This setup link was already used, or isn't this site's");
}

async function finishSetup(state: State, email: string, name: string | undefined): Promise<UserRow> {
  const user = await upsertUser(state, email, [OWNER], "setup", name);
  await createDb(state.db).delete(meta).where(eq(meta.key, "setup_token"));
  return user;
}

// --- Users and invites ------------------------------------------------------------------

function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Expected an email address");
  return email;
}

function checkRoles(state: State, roles: unknown): string[] {
  if(!Array.isArray(roles) || roles.some(role => typeof role !== "string")) throw new HttpError(400, "Expected roles as a list of role names");
  const known = new Set([OWNER, ...Object.keys(state.roles.map)]);
  const unknown = (roles as string[]).filter(role => !known.has(role));
  if(unknown.length) throw new HttpError(400, `Unknown roles: ${unknown.join(", ")}`);
  return [...new Set(roles as string[])];
}

async function upsertUser(state: State, email: string, roles: string[], by: string, name?: string): Promise<UserRow> {
  await createDb(state.db).insert(users)
    .values({ id: newId("user"), email, name: name ?? null, roles: JSON.stringify(roles), created_at: Date.now(), created_by: by })
    .onConflictDoUpdate({ target: users.email, set: { roles: sql`excluded.roles`, name: sql`coalesce(excluded.name, ${users.name})` } });
  return (await userBy(state, eq(users.email, email)))!;
}

export async function listUsers(state: State) {
  const rows = await createDb(state.db)
    .select({ ...getTableColumns(users), passkeys: sql<number>`(SELECT COUNT(*) FROM vibe_passkeys p WHERE p.user_id = vibe_users.id)` })
    .from(users)
    .orderBy(users.email);
  return rows.map(user => ({
    id: user.id,
    email: user.email,
    name: user.name,
    roles: JSON.parse(user.roles) as string[],
    passkeys: user.passkeys,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at
  }));
}

/**
 * Gives an email address roles on this site, and for passkey sign-in, a link to register a passkey
 * (inviting someone again is how they add a device or recover a lost passkey). Emailed when the
 * site can send email; returned either way, so it can be copied.
 */
/**
 * People who manage roles without being owners may only give out, and only change people who have,
 * roles within their own; never `owner`.
 */
function requireWithinReach(state: State, by: Session, roles: string[]) {
  if(fullRoleManager(state, by)) return;
  if(roles.includes(OWNER)) throw new HttpError(403, "Only owners can give or change the owner role");
  for(const role of roles) {
    const problem = outOfReach(state, by, state.roles.map[role]);
    if(problem) throw new HttpError(403, `${role}: ${problem}`);
  }
}

export async function invite(state: State, origin: string, by: Session, input: { email?: unknown, roles?: unknown }) {
  const email = normalizeEmail(input.email);
  const roles = checkRoles(state, input.roles ?? []);
  if(roles.length === 0) throw new HttpError(400, "Give the user at least one role");
  requireWithinReach(state, by, roles);
  const existing = await userBy(state, eq(users.email, email));
  if(existing) requireWithinReach(state, by, JSON.parse(existing.roles) as string[]);
  const user = await upsertUser(state, email, roles, by.email ?? by.sub);
  const mode = await signInMode(state);
  let link = `${origin}${state.prefix}/admin/`;
  if(mode === "passkey") {
    const token = randomString(24);
    const orm = createDb(state.db);
    await orm.delete(invites).where(or(eq(invites.user_id, user.id), lt(invites.expires_at, Date.now())));
    await orm.insert(invites).values({ hash: await sha256(token), user_id: user.id, created_by: by.email ?? by.sub, expires_at: Date.now() + INVITE_TTL });
    link = `${origin}${state.prefix}/admin/#invite=${token}`;
  }
  let emailed = false;
  let emailError: string | null = null;
  if(state.signIn.email) {
    const host = new URL(origin).host;
    const how = mode === "passkey"
      ? "Open this link within 7 days to create a passkey and sign in:"
      : "Sign in here with your work account:";
    try {
      await state.signIn.email.send({
        to: email,
        subject: `You're invited to edit ${host}`,
        text: `${by.name ?? by.email ?? "Someone"} invited you to edit ${host}.\n\n${how}\n${link}\n`
      });
      emailed = true;
    } catch (error) {
      emailError = (error as Error).message || "The email couldn't be sent";
    }
  }
  return { user: { id: user.id, email, roles }, link, emailed, emailError, expiresAt: mode === "passkey" ? Date.now() + INVITE_TTL : null };
}

export async function updateUser(state: State, by: Session, id: string, input: { roles?: unknown }) {
  const roles = checkRoles(state, input.roles);
  const user = await userBy(state, eq(users.id, id));
  if(!user) throw new HttpError(404, "No such user");
  requireWithinReach(state, by, [...roles, ...JSON.parse(user.roles) as string[]]);
  if(!roles.includes(OWNER) && await isLastOwner(state, user)) throw new HttpError(409, "The site needs at least one owner");
  await createDb(state.db).update(users).set({ roles: JSON.stringify(roles) }).where(eq(users.id, id));
  return { id, roles };
}

export async function removeUser(state: State, by: Session, id: string) {
  const user = await userBy(state, eq(users.id, id));
  if(!user) throw new HttpError(404, "No such user");
  requireWithinReach(state, by, JSON.parse(user.roles) as string[]);
  if(await isLastOwner(state, user)) throw new HttpError(409, "The site needs at least one owner");
  const orm = createDb(state.db);
  await orm.batch([
    orm.delete(passkeys).where(eq(passkeys.user_id, id)),
    orm.delete(invites).where(eq(invites.user_id, id)),
    orm.delete(users).where(eq(users.id, id))
  ]);
}

async function isLastOwner(state: State, user: UserRow): Promise<boolean> {
  if(!(JSON.parse(user.roles) as string[]).includes(OWNER)) return false;
  const [owners] = await createDb(state.db).select({ n: count() }).from(users).where(like(users.roles, ownerPattern));
  return (owners?.n ?? 0) <= 1;
}

// --- Signed-in browsers ---------------------------------------------------------------------

function signinCookie(state: State, url: URL, value: string, maxAge: number): string {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return `${SIGNIN_COOKIE}=${value}; Path=${state.prefix}/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

async function signIn(state: State, url: URL, identity: Identity, userId?: string): Promise<string> {
  // Fails here, before a cookie exists, for someone with no role on the site.
  await standaloneSession(state, identity);
  const token = randomString(32);
  const orm = createDb(state.db);
  await orm.delete(signins).where(lt(signins.expires_at, Date.now()));
  await orm.insert(signins).values({ hash: await sha256(token), identity: JSON.stringify(identity), expires_at: Date.now() + SIGNIN_TTL });
  if(userId) await orm.update(users).set({ last_sign_in_at: Date.now() }).where(eq(users.id, userId));
  return signinCookie(state, url, token, SIGNIN_TTL / 1000);
}

/** Who the signed-in browser's cookie belongs to. */
export async function cookieIdentity(state: State, cookie: string | undefined): Promise<Identity | null> {
  if(!cookie) return null;
  const [row] = await createDb(state.db).select({ identity: signins.identity, expires_at: signins.expires_at }).from(signins).where(eq(signins.hash, await sha256(cookie)));
  if(!row || row.expires_at < Date.now()) return null;
  return JSON.parse(row.identity) as Identity;
}

/** The signed-in browser's session, worked out again from the identity, so role changes apply at once. */
export async function resume(state: State, cookie: string | undefined): Promise<Session | null> {
  const identity = await cookieIdentity(state, cookie);
  return identity ? standaloneSession(state, identity) : null;
}

export async function signOut(state: State, url: URL, cookie: string | undefined): Promise<string> {
  if(cookie) await createDb(state.db).delete(signins).where(eq(signins.hash, await sha256(cookie)));
  return signinCookie(state, url, "", 0);
}

// --- Passkeys -------------------------------------------------------------------------------

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function saveChallenge(state: State, payload: Record<string, unknown>): Promise<string> {
  const id = randomString(16);
  const orm = createDb(state.db);
  await orm.delete(challenges).where(lt(challenges.expires_at, Date.now()));
  await orm.insert(challenges).values({ id, payload: JSON.stringify(payload), expires_at: Date.now() + CHALLENGE_TTL });
  return id;
}

/** Single use: deleted as it's read. */
async function takeChallenge<T>(state: State, id: unknown): Promise<T> {
  const [row] = typeof id === "string"
    ? await createDb(state.db).delete(challenges).where(eq(challenges.id, id)).returning({ payload: challenges.payload, expires_at: challenges.expires_at })
    : [];
  if(!row || row.expires_at < Date.now()) throw new HttpError(400, "This sign-in took too long. Try again.");
  return JSON.parse(row.payload) as T;
}

async function requirePasskeyMode(state: State) {
  const mode = await signInMode(state);
  if(mode !== "passkey") throw new HttpError(409, mode === "hub" ? "This site signs in through its org's hub" : "This site signs in with its identity provider");
}

interface RegistrationChallenge {
  challenge: string,
  email: string,
  /** The invite's user, or for the setup link, none yet. */
  userId?: string,
  inviteHash?: string,
  setup?: string,
  name?: string
}

/**
 * Starts registering a passkey: from an invite link (`invite`), or from the setup link (`setup`,
 * with the first owner's `email`).
 */
export async function registrationOptions(state: State, url: URL, input: { invite?: unknown, setup?: unknown, email?: unknown, name?: unknown }) {
  await requirePasskeyMode(state);
  let pending: Omit<RegistrationChallenge, "challenge">;
  let existing: Array<{ id: string, transports: string | null }> = [];
  if(typeof input.setup === "string") {
    await checkSetupToken(state, input.setup);
    pending = { email: normalizeEmail(input.email), setup: input.setup, name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : undefined };
  } else if(typeof input.invite === "string") {
    const hash = await sha256(input.invite);
    const [found] = await createDb(state.db)
      .select({ user_id: invites.user_id, expires_at: invites.expires_at, email: users.email })
      .from(invites)
      .innerJoin(users, eq(users.id, invites.user_id))
      .where(eq(invites.hash, hash));
    if(!found || found.expires_at < Date.now()) throw new HttpError(403, "This invite link expired or was already used. Ask for a new one.");
    pending = { email: found.email, userId: found.user_id, inviteHash: hash };
    existing = await createDb(state.db).select({ id: passkeys.id, transports: passkeys.transports }).from(passkeys).where(eq(passkeys.user_id, found.user_id));
  } else {
    throw new HttpError(400, "Expected an invite or the setup link");
  }
  const site = await getMeta(state.db, "site");
  const options = await generateRegistrationOptions({
    rpName: site ? (JSON.parse(site) as { name?: string }).name ?? url.host : url.host,
    rpID: url.hostname,
    userName: pending.email,
    userDisplayName: pending.name ?? pending.email,
    attestationType: "none",
    excludeCredentials: existing.map(key => ({ id: key.id, transports: key.transports ? JSON.parse(key.transports) as AuthenticatorTransportFuture[] : undefined })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" }
  });
  const challengeId = await saveChallenge(state, { ...pending, challenge: options.challenge });
  return { challengeId, options };
}

/** Finishes registering: stores the passkey, uses up the invite or setup link, and signs the browser in. */
export async function register(state: State, url: URL, input: { challengeId?: unknown, response?: unknown }): Promise<{ cookie: string }> {
  await requirePasskeyMode(state);
  const pending = await takeChallenge<RegistrationChallenge>(state, input.challengeId);
  const verification = await verifyRegistrationResponse({
    response: input.response as RegistrationResponseJSON,
    expectedChallenge: pending.challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    requireUserVerification: false
  }).catch((error: Error) => {
    throw new HttpError(400, `The passkey couldn't be checked: ${error.message}`);
  });
  if(!verification.verified || !verification.registrationInfo) throw new HttpError(400, "The passkey couldn't be checked");
  let userId = pending.userId;
  if(pending.setup) {
    await checkSetupToken(state, pending.setup);
    userId = (await finishSetup(state, pending.email, pending.name)).id;
  } else {
    const [used] = await createDb(state.db).delete(invites).where(eq(invites.hash, pending.inviteHash ?? "")).returning({ hash: invites.hash });
    if(!used) throw new HttpError(403, "This invite link was already used. Ask for a new one.");
  }
  const { credential } = verification.registrationInfo;
  await createDb(state.db).insert(passkeys).values({
    id: credential.id,
    user_id: userId!,
    public_key: b64url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports ? JSON.stringify(credential.transports) : null,
    created_at: Date.now()
  });
  const user = (await userBy(state, eq(users.id, userId!)))!;
  return { cookie: await signIn(state, url, { sub: `vibe|${user.id}`, email: user.email, emailVerified: true, name: user.name ?? undefined }, user.id) };
}

/** Starts signing in with any passkey for this site; the browser offers the ones it has. */
export async function authenticationOptions(state: State, url: URL) {
  await requirePasskeyMode(state);
  const options = await generateAuthenticationOptions({ rpID: url.hostname, userVerification: "preferred" });
  return { challengeId: await saveChallenge(state, { challenge: options.challenge }), options };
}

export async function authenticate(state: State, url: URL, input: { challengeId?: unknown, response?: unknown }): Promise<{ cookie: string }> {
  await requirePasskeyMode(state);
  const { challenge } = await takeChallenge<{ challenge: string }>(state, input.challengeId);
  const response = input.response as AuthenticationResponseJSON;
  const [key] = await createDb(state.db).select().from(passkeys).where(eq(passkeys.id, typeof response?.id === "string" ? response.id : ""));
  if(!key) throw new HttpError(401, "This passkey isn't registered on this site");
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: url.origin,
    expectedRPID: url.hostname,
    credential: {
      id: key.id,
      publicKey: fromB64url(key.public_key),
      counter: key.counter,
      transports: key.transports ? JSON.parse(key.transports) as AuthenticatorTransportFuture[] : undefined
    },
    requireUserVerification: false
  }).catch(() => ({ verified: false as const, authenticationInfo: undefined }));
  if(!verification.verified) throw new HttpError(401, "The passkey couldn't be checked");
  await createDb(state.db).update(passkeys).set({ counter: verification.authenticationInfo!.newCounter, last_used_at: Date.now() }).where(eq(passkeys.id, key.id));
  const user = await userBy(state, eq(users.id, key.user_id));
  if(!user) throw new HttpError(401, "This passkey's user was removed");
  return { cookie: await signIn(state, url, { sub: `vibe|${user.id}`, email: user.email, emailVerified: true, name: user.name ?? undefined }, user.id) };
}

// --- The site's own identity provider ------------------------------------------------------

function oidcConfig(state: State) {
  if(!state.signIn.oidc) throw new HttpError(409, "This site has no identity provider (OIDC_ISSUER)");
  return state.signIn.oidc;
}

/** `GET {prefix}/api/auth/oidc/login`: off to the identity provider, bound to this browser by a short cookie. */
export async function oidcLogin(state: State, url: URL): Promise<Response> {
  if(await signInMode(state) !== "oidc") throw new HttpError(409, "This site doesn't sign in with an identity provider");
  const config = oidcConfig(state);
  const setup = url.searchParams.get("setup") ?? undefined;
  if(setup) await checkSetupToken(state, setup);
  const nonce = randomString();
  const verifier = randomString(48);
  const state_ = await saveChallenge(state, { nonce, verifier, setup });
  const location = await authorizationUrl(config, { redirectUri: `${url.origin}${state.prefix}/api/auth/oidc/callback`, state: state_, nonce, verifier });
  const secure = url.protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 302,
    headers: { location, "set-cookie": `${LOGIN_COOKIE}=${state_}; Path=${state.prefix}/; HttpOnly; SameSite=Lax; Max-Age=600${secure}`, "cache-control": "no-store" }
  });
}

export async function oidcCallback(state: State, url: URL, loginCookie: string | undefined): Promise<Response> {
  const admin = `${url.origin}${state.prefix}/admin/`;
  function back(headers: Record<string, string> = {}, error?: string) {
    return new Response(null, {
      status: 302,
      headers: { location: error ? `${admin}#error=${encodeURIComponent(error)}` : admin, "cache-control": "no-store", ...headers }
    });
  }
  const config = oidcConfig(state);
  const id = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if(url.searchParams.get("error")) return back({}, url.searchParams.get("error_description") ?? url.searchParams.get("error")!);
  if(!id || !code || loginCookie !== id) return back({}, "Sign-in expired. Try again.");
  let pending: { nonce: string, verifier: string, setup?: string };
  try {
    pending = await takeChallenge(state, id);
  } catch {
    return back({}, "Sign-in expired. Try again.");
  }
  let claims;
  try {
    const tokens = await exchangeCode(config, { code, redirectUri: `${url.origin}${state.prefix}/api/auth/oidc/callback`, verifier: pending.verifier });
    claims = await verifyIdToken(config, tokens.id_token, pending.nonce);
  } catch (error) {
    return back({}, `Sign-in failed: ${(error as Error).message}`);
  }
  if(!isAllowed(config.allow, claims)) return back({}, "Your account isn't allowed to sign in to this site.");
  const email = typeof claims.email === "string" ? claims.email : undefined;
  const emailVerified = claims.email_verified === true;
  const name = typeof claims.name === "string" ? claims.name : undefined;
  if(pending.setup) {
    if(!email || !emailVerified) return back({}, "The setup link needs an account with a verified email address.");
    try {
      await checkSetupToken(state, pending.setup);
    } catch (error) {
      return back({}, (error as Error).message);
    }
    await finishSetup(state, email.toLowerCase(), name);
  }
  const claim = config.rolesClaim ? claims[config.rolesClaim] : undefined;
  const claimRoles = config.rolesClaim ? (Array.isArray(claim) ? claim.map(String) : typeof claim === "string" ? [claim] : []) : undefined;
  const identity: Identity = { sub: `${claims.iss}|${claims.sub}`, email, emailVerified, name, claimRoles };
  const user = email && emailVerified ? await userBy(state, eq(users.email, email.toLowerCase())) : null;
  try {
    const cookie = await signIn(state, url, identity, user?.id);
    const headers = new Headers({ location: admin, "cache-control": "no-store" });
    headers.append("set-cookie", cookie);
    headers.append("set-cookie", `${LOGIN_COOKIE}=; Path=${state.prefix}/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return back({}, error instanceof HttpError ? error.message : "Sign-in failed");
  }
}
