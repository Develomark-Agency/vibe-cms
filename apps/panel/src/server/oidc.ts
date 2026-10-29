import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export interface OidcConfig {
  issuer: string,
  clientId: string,
  clientSecret: string,
  scopes: string
}

interface Discovery {
  issuer: string,
  authorization_endpoint: string,
  token_endpoint: string,
  jwks_uri: string,
  end_session_endpoint?: string
}

const cache = new Map<string, { at: number, doc: Discovery, jwks: ReturnType<typeof createRemoteJWKSet> }>();

export async function discover(issuer: string) {
  const hit = cache.get(issuer);
  if(hit && Date.now() - hit.at < 3600_000) return hit;
  const response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if(!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
  const doc = await response.json() as Discovery;
  const entry = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
  cache.set(issuer, entry);
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

export async function authorizationUrl(config: OidcConfig, params: { redirectUri: string, state: string, nonce: string, verifier: string }) {
  const { doc } = await discover(config.issuer);
  const url = new URL(doc.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: params.redirectUri,
    scope: config.scopes,
    state: params.state,
    nonce: params.nonce,
    code_challenge: await pkceChallenge(params.verifier),
    code_challenge_method: "S256",
    // Google only issues refresh tokens when asked like this.
    ...(new URL(config.issuer).host === "accounts.google.com" ? { access_type: "offline", prompt: "consent" } : {})
  }).toString();
  return url.toString();
}

export interface Tokens {
  id_token: string,
  refresh_token?: string
}

async function tokenRequest(config: OidcConfig, body: Record<string, string>): Promise<Tokens> {
  const { doc } = await discover(config.issuer);
  const response = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`)}`
    },
    body: new URLSearchParams(body)
  });
  const data = await response.json() as Tokens & { error?: string, error_description?: string };
  if(!response.ok || !data.id_token) throw new Error(data.error_description ?? data.error ?? `Token request failed (${response.status})`);
  return data;
}

export function exchangeCode(config: OidcConfig, params: { code: string, redirectUri: string, verifier: string }) {
  return tokenRequest(config, {
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.verifier
  });
}

export function refresh(config: OidcConfig, refreshToken: string) {
  return tokenRequest(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

export async function verifyIdToken(config: OidcConfig, idToken: string, nonce?: string): Promise<JWTPayload> {
  const { doc, jwks } = await discover(config.issuer);
  const { payload } = await jwtVerify(idToken, jwks, { issuer: doc.issuer, audience: config.clientId });
  if(nonce !== undefined && payload.nonce !== nonce) throw new Error("Nonce mismatch");
  return payload;
}

/**
 * `PANEL_ALLOW`: comma-separated email domains (`my-agency.com`) or group
 * claim values. Domains need a verified email.
 */
export function isAllowed(allow: string | undefined, claims: JWTPayload): boolean {
  const rules = (allow ?? "").split(",").map(r => r.trim().toLowerCase()).filter(Boolean);
  if(rules.length === 0) return true;
  const email = typeof claims.email === "string" && claims.email_verified === true ? claims.email.toLowerCase() : undefined;
  const domain = email?.split("@")[1];
  const groups = [claims.groups, claims.roles].flatMap(g => (Array.isArray(g) ? g : typeof g === "string" ? [g] : [])).map(g => String(g).toLowerCase());
  return rules.some(rule => rule === domain || groups.includes(rule));
}
