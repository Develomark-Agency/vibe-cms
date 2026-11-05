/**
 * A small OpenID Connect client: discovery, authorization code with PKCE, ID token checks. The hub
 * uses it, and so does a site that signs people in with its own identity provider (`OIDC_*`).
 *
 * It reads what the provider says it supports (its discovery document) rather than assuming one
 * provider's habits: how the client authenticates at the token endpoint, which scopes are offered,
 * whether a refresh returns a new ID token, and where claims the ID token leaves out can be found.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OidcConfig {
  /** The issuer's address, or its discovery URL (the one ending `/.well-known/openid-configuration`). */
  issuer: string,
  clientId: string,
  clientSecret: string,
  /**
   * Space-separated scopes. Unset asks for `openid email profile`, plus `offline_access` when the provider
   * offers it, which is how most providers decide to hand out a refresh token.
   */
  scopes?: string,
  /** The provider doesn't say whether emails are verified (or says nothing), but checks them itself: count them as verified. */
  trustEmail?: boolean,
  /** The claim whose values are groups or roles, besides `groups` and `roles`. A full claim name, like Auth0's `https://app/roles`, works. */
  rolesClaim?: string
}

export interface Discovery {
  issuer: string,
  authorization_endpoint: string,
  token_endpoint: string,
  jwks_uri: string,
  userinfo_endpoint?: string,
  end_session_endpoint?: string,
  scopes_supported?: string[],
  token_endpoint_auth_methods_supported?: string[],
  code_challenge_methods_supported?: string[],
  claims_supported?: string[]
}

const WELL_KNOWN = "/.well-known/openid-configuration";

/** An issuer as people paste it: with a trailing slash, or as the discovery URL the provider's dashboard shows. */
export function normalizeIssuer(value: string): string {
  let issuer = value.trim();
  if(issuer.endsWith(WELL_KNOWN)) issuer = issuer.slice(0, -WELL_KNOWN.length);
  return issuer.replace(/\/+$/, "");
}

type ClientAuth = "basic" | "post";

interface CacheEntry {
  at: number,
  doc: Discovery,
  jwks: ReturnType<typeof createRemoteJWKSet>,
  /** The way of authenticating at the token endpoint that worked last. */
  auth?: ClientAuth
}

const cache = new Map<string, CacheEntry>();

/** Forgets what was learned about providers: discovery documents and which client authentication worked. */
export function clearDiscoveryCache() {
  cache.clear();
}

export async function discover(issuer: string): Promise<CacheEntry> {
  const key = normalizeIssuer(issuer);
  const hit = cache.get(key);
  if(hit && Date.now() - hit.at < 3600_000) return hit;
  const response = await fetch(`${key}${WELL_KNOWN}`);
  if(!response.ok) throw new Error(`OIDC discovery failed (${response.status}) at ${key}${WELL_KNOWN}`);
  const doc = await response.json() as Discovery;
  if(!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error(`${key} isn't an OpenID Connect provider: its discovery document is missing endpoints`);
  const entry: CacheEntry = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)), auth: hit?.auth };
  cache.set(key, entry);
  return entry;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** The scopes to ask for: the configured ones, or the defaults plus `offline_access` where the provider offers it. */
export function scopesFor(config: Pick<OidcConfig, "scopes" | "issuer">, doc: Pick<Discovery, "scopes_supported">): string {
  if(config.scopes?.trim()) return config.scopes.trim();
  const scopes = ["openid", "email", "profile"];
  // Google hands out refresh tokens for `access_type=offline` and doesn't list `offline_access`.
  if(doc.scopes_supported?.includes("offline_access")) scopes.push("offline_access");
  return scopes.join(" ");
}

export async function authorizationUrl(config: OidcConfig, params: { redirectUri: string, state: string, nonce: string, verifier: string, loginHint?: string }) {
  const { doc } = await discover(config.issuer);
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
    scope: scopesFor(config, doc),
    state: params.state,
    nonce: params.nonce,
    code_challenge: await pkceChallenge(params.verifier),
    code_challenge_method: "S256",
    ...(params.loginHint ? { login_hint: params.loginHint } : {}),
    // Google only issues refresh tokens when asked like this.
    ...(new URL(doc.issuer || config.issuer).host === "accounts.google.com" ? { access_type: "offline", prompt: "consent" } : {})
  }).toString();
  return url.toString();
}

export interface Tokens {
  id_token: string,
  access_token?: string,
  refresh_token?: string
}

/** What a refresh returns: providers may leave the ID token out, which means "still signed in". */
export interface RefreshedTokens {
  id_token?: string,
  access_token?: string,
  refresh_token?: string
}

interface TokenReply {
  id_token?: string,
  access_token?: string,
  refresh_token?: string,
  error?: string,
  error_description?: string
}

async function tokenRequest(config: OidcConfig, body: Record<string, string>): Promise<{ data: TokenReply, status: number }> {
  const entry = await discover(config.issuer);
  const { doc } = entry;
  const methods = doc.token_endpoint_auth_methods_supported;
  // The default is Basic. A provider that lists only the body method gets that first.
  const preferred: ClientAuth = methods && !methods.includes("client_secret_basic") && methods.includes("client_secret_post") ? "post" : "basic";
  const order: ClientAuth[] = entry.auth ? [entry.auth] : [preferred, preferred === "basic" ? "post" : "basic"];
  let last: { data: TokenReply, status: number } | undefined;
  for(const auth of order) {
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const form = new URLSearchParams(body);
    if(auth === "basic") headers.authorization = `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}`;
    else {
      form.set("client_id", config.clientId);
      form.set("client_secret", config.clientSecret);
    }
    const response = await fetch(doc.token_endpoint, { method: "POST", headers, body: form });
    const data = await response.json().catch(() => ({})) as TokenReply;
    last = { data, status: response.status };
    if(response.ok) {
      entry.auth = auth;
      return last;
    }
    // Only a provider refusing the client is worth another way of authenticating; anything else won't change.
    if(data.error !== "invalid_client" || entry.auth) break;
  }
  return last!;
}

function failure({ data, status }: { data: TokenReply, status: number }): Error {
  return new Error(data.error_description ?? data.error ?? `Token request failed (${status})`);
}

export async function exchangeCode(config: OidcConfig, params: { code: string, redirectUri: string, verifier: string }): Promise<Tokens> {
  const reply = await tokenRequest(config, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier
  });
  if(reply.status >= 400 || !reply.data.id_token) throw failure(reply);
  return reply.data as Tokens;
}

export async function refresh(config: OidcConfig, refreshToken: string): Promise<RefreshedTokens> {
  const reply = await tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
  // The spec makes the ID token optional here, so a reply without one is still a success.
  if(reply.status >= 400 || !(reply.data.id_token || reply.data.access_token || reply.data.refresh_token)) throw failure(reply);
  return reply.data;
}

export async function verifyIdToken(config: OidcConfig, idToken: string, nonce?: string): Promise<JWTPayload> {
  const { doc, jwks } = await discover(config.issuer);
  // A little tolerance: providers' clocks and ours don't agree to the second.
  const { payload } = await jwtVerify(idToken, jwks, { issuer: doc.issuer, audience: config.clientId, clockTolerance: 30 });
  if(nonce !== undefined && payload.nonce !== nonce) throw new Error("Nonce mismatch");
  return payload;
}

/**
 * The ID token's claims, with what it left out filled from the provider's userinfo endpoint: some
 * providers keep the email there. The ID token wins wherever both have a claim, and userinfo is
 * ignored unless it's about the same subject.
 */
export async function completeClaims(config: OidcConfig, claims: JWTPayload, tokens: { access_token?: string }): Promise<JWTPayload> {
  if(typeof claims.email === "string" && claims.email || !tokens.access_token) return claims;
  const { doc } = await discover(config.issuer);
  if(!doc.userinfo_endpoint) return claims;
  const response = await fetch(doc.userinfo_endpoint, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" } }).catch(() => null);
  const info = response?.ok ? await response.json().catch(() => null) as Record<string, unknown> | null : null;
  if(!info || info.sub !== claims.sub) return claims;
  return { ...info, ...claims };
}

export interface OidcIdentity {
  email?: string,
  emailVerified: boolean,
  name?: string
}

/** Whether the provider vouches for the email, in the forms providers send it (`true`, `"true"`), or the config says to trust it. */
export function emailVerified(config: Pick<OidcConfig, "trustEmail">, claims: JWTPayload): boolean {
  const claim = claims.email_verified;
  if(claim === true || claim === "true") return true;
  if(claim === false || claim === "false") return false;
  return config.trustEmail === true;
}

/** Email and name from a user's claims, whichever way the provider spells them. */
export function identityOf(config: Pick<OidcConfig, "trustEmail">, claims: JWTPayload): OidcIdentity {
  const email = typeof claims.email === "string" && claims.email ? claims.email : undefined;
  const joined = [claims.given_name, claims.family_name].filter((part): part is string => typeof part === "string" && part !== "").join(" ");
  const name = [claims.name, joined, claims.preferred_username].find((value): value is string => typeof value === "string" && value !== "");
  return { email, emailVerified: Boolean(email) && emailVerified(config, claims), name };
}

/** A claim's values as a list: by its exact name (`https://app/roles` is one), else as a dotted path into nested claims. */
export function claimValues(claims: JWTPayload, name: string | undefined): string[] {
  if(!name) return [];
  let value: unknown = name in claims ? claims[name] : name.split(".").reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined), claims);
  if(typeof value === "string") value = [value];
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * `PANEL_ALLOW` (the hub) or `VIBE_ALLOW` (a site signing in by itself): comma-separated email
 * domains (`my-agency.com`) or group claim values. Domains need a verified email. Empty allows all.
 */
export function isAllowed(allow: string | undefined, claims: JWTPayload, config: Pick<OidcConfig, "trustEmail" | "rolesClaim"> = {}): boolean {
  const rules = (allow ?? "").split(",").map(r => r.trim().toLowerCase()).filter(Boolean);
  if(rules.length === 0) return true;
  const { email, emailVerified: verified } = identityOf(config, claims);
  const domain = verified ? email?.toLowerCase().split("@")[1] : undefined;
  const groups = [...claimValues(claims, "groups"), ...claimValues(claims, "roles"), ...claimValues(claims, config.rolesClaim)].map(g => g.toLowerCase());
  return rules.some(rule => rule === domain || groups.includes(rule));
}
