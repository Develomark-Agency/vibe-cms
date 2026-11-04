import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from "jose";
import { PanelError, type PanelSite } from "vibe-cms/panel";
import { randomString } from "./oidc.ts";
import { freshIdToken, json, type Env, type SessionRow } from "./shared.ts";

/**
 * The panel as the hub sites trust (`auth: hub({ url })`). It signs people in with the
 * identity provider, then vouches for them to one site at a time with short-lived tokens
 * addressed to that site. Sites check those against the keys at `/.well-known/jwks.json`
 * and decide roles themselves, so the hub never needs to know who may do what.
 */

/** Long enough for a server-to-server handoff or a CLI command's first request; sites hand out their own sessions after that. */
const TOKEN_TTL = "5m";

/** Provider claims that only mean something to the hub, not passed on to sites. */
const PROVIDER_ONLY = new Set(["iss", "sub", "aud", "exp", "iat", "nbf", "jti", "nonce", "at_hash", "c_hash", "azp", "auth_time", "acr", "amr", "sid"]);

async function meta(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM panel_meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

/** The hub's address: the `iss` of its tokens, and what sites name in `auth: hub({ url })`. Cron runs have no request to read it from. */
export async function hubOrigin(env: Env): Promise<string | null> {
  if(env.PANEL_URL) return env.PANEL_URL.replace(/\/$/, "");
  return meta(env, "origin");
}

let knownOrigin: string | undefined;

/** Remembers the address requests arrive at, for cron runs. */
export async function rememberOrigin(env: Env, origin: string) {
  if(env.PANEL_URL || knownOrigin === origin) return;
  knownOrigin = origin;
  await env.DB.prepare("INSERT INTO panel_meta (key, value) VALUES ('origin', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(origin).run();
}

/** The hub's signing key pair, made on first use and kept in D1. */
async function signingKey(env: Env): Promise<{ kid: string, privateJwk: JWK, publicJwk: JWK }> {
  const stored = await meta(env, "signing_key");
  if(stored) return JSON.parse(stored);
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const kid = randomString(8);
  const key = { kid, privateJwk: await exportJWK(privateKey), publicJwk: { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" } };
  await env.DB.prepare("INSERT OR IGNORE INTO panel_meta (key, value) VALUES ('signing_key', ?)").bind(JSON.stringify(key)).run();
  return JSON.parse((await meta(env, "signing_key"))!);
}

/** `/.well-known/jwks.json`: the keys sites verify the hub's tokens with. */
export async function jwks(env: Env): Promise<Response> {
  const { publicJwk } = await signingKey(env);
  return json({ keys: [publicJwk] }, { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
}

async function sign(env: Env, claims: Record<string, unknown>, subject: string, siteId: string, ttl: string): Promise<string> {
  const issuer = await hubOrigin(env);
  if(!issuer) throw new PanelError(500, "The panel doesn't know its own address yet. Set PANEL_URL, or open the panel once.");
  const { kid, privateJwk } = await signingKey(env);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(issuer)
    .setAudience(siteId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(await importJWK(privateJwk, "ES256"));
}

/**
 * Vouches for a signed-in user to one site. The identity is the provider's (`<issuer>|<sub>`),
 * with its other claims (email, groups, …) passed through for the site's role mapping. The
 * provider sign-in is refreshed first, so someone the provider dropped stops getting tokens.
 */
export async function userToken(env: Env, session: SessionRow, siteId: string): Promise<string> {
  const claims = decodeJwt(await freshIdToken(env, session));
  const passed = Object.fromEntries(Object.entries(claims).filter(([key]) => !PROVIDER_ONLY.has(key)));
  return sign(env, passed, `${claims.iss}|${claims.sub}`, siteId, TOKEN_TTL);
}

/** Lets the hub itself run backup actions on one site, and nothing else. Sites opt in with `backups: true`. */
export function backupToken(env: Env, siteId: string): Promise<string> {
  return sign(env, { scope: "backups" }, "hub", siteId, "15m");
}

/** `https://site.com/_vibe/admin` → `https://site.com/_vibe`. */
export function apiBase(site: PanelSite): string {
  return site.admin.replace(/\/admin\/?$/, "");
}

/** Hub → site, server to server: a user token in, a one-time code for the site's editor out. */
export async function codeFor(env: Env, session: SessionRow, site: PanelSite): Promise<string> {
  const response = await fetch(`${apiBase(site)}/api/session/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: await userToken(env, session, site.id) })
  });
  const data = await response.json().catch(() => ({})) as { code?: string, error?: string };
  if(!response.ok || !data.code) {
    throw new PanelError(response.status === 403 ? 403 : 502, data.error ?? `The site refused the sign-in (${response.status})`);
  }
  return data.code;
}
