import { decodeJwt, importJWK, SignJWT, type JWK } from "jose";
import { fetchDescriptor, PanelError, type PanelSite } from "vibe-cms/panel";
import { normalizeOrg, ORG_MOVE_SCOPE, ORG_MOVE_TOKEN_TTL } from "vibe-cms/org";
import { freshIdToken, json, type Env, type SessionRow } from "./shared.ts";

/**
 * The panel as the hub of an org. Sites trust the org (`VIBE_ORG`), find this hub through the
 * org's `_vibe-hub` DNS record, and check its tokens against the keys at `/.well-known/jwks.json`.
 * The hub signs people in with the identity provider, then vouches for them to one site at a time
 * with short-lived tokens addressed to that site; sites decide roles themselves.
 *
 * The signing key is a Worker secret (`HUB_SIGNING_KEY`), which can be set but never read back.
 */

/** Long enough for a server-to-server handoff or a CLI command's first request; sites hand out their own sessions after that. */
const TOKEN_TTL = "5m";

/** Provider claims that only mean something to the hub, not passed on to sites. `roles` is the hub's to fill. */
const PROVIDER_ONLY = new Set(["iss", "sub", "aud", "exp", "iat", "nbf", "jti", "nonce", "at_hash", "c_hash", "azp", "auth_time", "acr", "amr", "sid", "scope", "roles"]);

async function meta(env: Env, key: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT value FROM panel_meta WHERE key = ?").bind(key).first<{ value: string }>())?.value ?? null;
}

async function setMeta(env: Env, key: string, value: string) {
  await env.DB.prepare("INSERT INTO panel_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();
}

/** The hub's own address, for links and OAuth. Cron runs have no request to read it from. */
export async function hubOrigin(env: Env): Promise<string | null> {
  if(env.PANEL_URL) return env.PANEL_URL.replace(/\/$/, "");
  return meta(env, "origin");
}

let knownOrigin: string | undefined;

/** Remembers the address requests arrive at, for cron runs. */
export async function rememberOrigin(env: Env, origin: string) {
  if(env.PANEL_URL || knownOrigin === origin) return;
  knownOrigin = origin;
  await setMeta(env, "origin", origin);
}

/** The org this hub signs for: `VIBE_ORG`. */
export function hubOrg(env: Env): string {
  const org = normalizeOrg(env.VIBE_ORG);
  if(!org) throw new PanelError(500, env.VIBE_ORG ? `VIBE_ORG "${env.VIBE_ORG}" isn't a domain like my-org.com or a URL` : "Set VIBE_ORG to your org's domain, e.g. my-org.com");
  return org;
}

/**
 * Notices when `VIBE_ORG` changed and remembers the orgs the hub used to be. It keeps signing for
 * sites that still trust an old one until they accept the move, so nobody is locked out meanwhile.
 */
export async function syncOrg(env: Env): Promise<{ org: string, previous: string[] }> {
  const org = hubOrg(env);
  const stored = await meta(env, "org");
  let previous = JSON.parse(await meta(env, "previous_orgs") ?? "[]") as string[];
  if(stored !== org) {
    if(stored) previous = [...previous.filter(p => p !== stored && p !== org), stored];
    else previous = previous.filter(p => p !== org);
    await setMeta(env, "previous_orgs", JSON.stringify(previous));
    await setMeta(env, "org", org);
  }
  return { org, previous };
}

interface SigningKey {
  kid: string,
  privateKey: CryptoKey,
  publicJwk: JWK
}

let cachedKey: { source: string, key: Promise<SigningKey> } | undefined;

/** The hub's signing key pair, from the `HUB_SIGNING_KEY` secret (a private ES256 JWK with a `kid`). */
async function signingKey(env: Env): Promise<SigningKey> {
  const source = env.HUB_SIGNING_KEY;
  if(!source) throw new PanelError(500, "Set the HUB_SIGNING_KEY secret: run `bunx vibe-cms hub keygen` and store its output with `wrangler secret put HUB_SIGNING_KEY`");
  if(cachedKey?.source !== source) {
    cachedKey = {
      source,
      key: (async () => {
        let jwk: JWK;
        try {
          jwk = JSON.parse(source) as JWK;
        } catch {
          throw new PanelError(500, "HUB_SIGNING_KEY isn't JSON. Generate one with `bunx vibe-cms hub keygen`");
        }
        if(jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.kid) throw new PanelError(500, "HUB_SIGNING_KEY must be a private P-256 key with a kid, from `bunx vibe-cms hub keygen`");
        const { d: _private, ...rest } = jwk;
        return {
          kid: jwk.kid,
          privateKey: await importJWK(jwk, "ES256") as CryptoKey,
          publicJwk: { kty: rest.kty, crv: rest.crv, x: rest.x, y: rest.y, kid: jwk.kid, alg: "ES256", use: "sig" }
        };
      })()
    };
    cachedKey.key.catch(() => (cachedKey = undefined));
  }
  return cachedKey.key;
}

/** `/.well-known/jwks.json`: the keys sites verify the hub's tokens with. */
export async function jwks(env: Env): Promise<Response> {
  const { publicJwk } = await signingKey(env);
  return json({ keys: [publicJwk] }, { headers: { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
}

/** The org a site trusts, as last seen in its descriptor. */
export async function siteOrg(env: Env, siteId: string): Promise<string | null> {
  return (await env.DB.prepare("SELECT org FROM sites WHERE id = ?").bind(siteId).first<{ org: string | null }>())?.org ?? null;
}

/** Signs as the org the site trusts: the current one, or one this hub used to be while the site's move is pending. */
async function issuerFor(env: Env, siteId: string): Promise<string> {
  const { org, previous } = await syncOrg(env);
  const trusted = await siteOrg(env, siteId);
  return trusted && previous.includes(trusted) ? trusted : org;
}

async function sign(env: Env, claims: Record<string, unknown>, subject: string, siteId: string, ttl: string, issuer?: string): Promise<string> {
  const { kid, privateKey } = await signingKey(env);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid })
    .setIssuer(issuer ?? await issuerFor(env, siteId))
    .setAudience(siteId)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(privateKey);
}

/** The values of the identity provider claim named in `OIDC_ROLES_CLAIM`, which sites read as `roles`. */
function providerRoles(env: Env, claims: Record<string, unknown>): string[] | undefined {
  if(!env.OIDC_ROLES_CLAIM) return undefined;
  const claim = claims[env.OIDC_ROLES_CLAIM];
  return Array.isArray(claim) ? claim.map(String) : typeof claim === "string" ? [claim] : [];
}

/**
 * Vouches for a signed-in user to one site. The identity is the provider's (`<issuer>|<sub>`),
 * with its other claims (email, name, …) passed through for the site's role mapping. The
 * provider sign-in is refreshed first, so someone the provider dropped stops getting tokens.
 */
export async function userToken(env: Env, session: SessionRow, siteId: string): Promise<string> {
  const claims = decodeJwt(await freshIdToken(env, session));
  const passed: Record<string, unknown> = Object.fromEntries(Object.entries(claims).filter(([key]) => !PROVIDER_ONLY.has(key)));
  const roles = providerRoles(env, claims);
  if(roles) passed.roles = roles;
  return sign(env, passed, `${claims.iss}|${claims.sub}`, siteId, TOKEN_TTL);
}

/** Lets the hub itself run backup actions on one site, and nothing else. Sites opt in with `backups: true`. */
export function backupToken(env: Env, siteId: string): Promise<string> {
  return sign(env, { scope: "backups" }, "hub", siteId, "15m");
}

/** `https://site.com/_vibe/admin` → `https://site.com/_vibe`. */
export function apiBase(site: Pick<PanelSite, "admin">): string {
  return site.admin.replace(/\/admin\/?$/, "");
}

/** Reads a site's descriptor again and records the org it trusts now. */
export async function refreshSiteOrg(env: Env, site: Pick<PanelSite, "id" | "url">): Promise<{ org: string | null, move: { to: string, effectiveAt: number } | null } | null> {
  const descriptor = await fetchDescriptor(site.url).catch(() => null);
  if(!descriptor || descriptor.id !== site.id) return null;
  await env.DB.prepare("UPDATE sites SET org = ? WHERE id = ?").bind(descriptor.org, site.id).run();
  return { org: descriptor.org, move: descriptor.orgMove };
}

/** Hub → site, server to server: a user token in, a one-time code for the site's editor out. */
export async function codeFor(env: Env, session: SessionRow, site: PanelSite): Promise<string> {
  for(const retry of [false, true]) {
    const response = await fetch(`${apiBase(site)}/api/session/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: await userToken(env, session, site.id) })
    });
    const data = await response.json().catch(() => ({})) as { code?: string, error?: string };
    if(response.ok && data.code) return data.code;
    // The site may have accepted a move since the hub last looked: sign for its org now, once.
    if(response.status === 401 && !retry && await refreshSiteOrg(env, site)) continue;
    throw new PanelError(response.status === 403 ? 403 : 502, data.error ?? `The site refused the sign-in (${response.status})`);
  }
  throw new PanelError(502, "The site refused the sign-in");
}

export interface OrgSiteStatus {
  id: string,
  name: string,
  org: string | null,
  state: "current" | "pending" | "requested" | "unreachable" | "refused" | "foreign",
  effectiveAt?: number,
  error?: string
}

/**
 * Asks every site that still trusts one of the hub's previous orgs to move to the current one, signed
 * with the hub's key. Sites accept after their delay (72 hours by default). Runs from the cron, and on
 * demand from the panel; sites that already moved or have a move pending are left alone.
 */
export async function moveSites(env: Env): Promise<{ org: string, previous: string[], sites: OrgSiteStatus[] }> {
  const { org, previous } = await syncOrg(env);
  const { results } = await env.DB.prepare("SELECT id, url, name, admin, org FROM sites WHERE org IS NULL OR org != ?").bind(org)
    .all<{ id: string, url: string, name: string, admin: string, org: string | null }>();
  const sites: OrgSiteStatus[] = [];
  for(const site of results) {
    const seen = await refreshSiteOrg(env, site);
    if(!seen) {
      sites.push({ id: site.id, name: site.name, org: site.org, state: "unreachable" });
      continue;
    }
    if(seen.org === org) {
      sites.push({ id: site.id, name: site.name, org, state: "current" });
    } else if(seen.move?.to === org) {
      sites.push({ id: site.id, name: site.name, org: seen.org, state: "pending", effectiveAt: seen.move.effectiveAt });
    } else if(!seen.org || !previous.includes(seen.org)) {
      // A site that trusts an org this hub never was isn't this hub's to move.
      sites.push({ id: site.id, name: site.name, org: seen.org, state: "foreign" });
    } else {
      const token = await sign(env, { scope: ORG_MOVE_SCOPE, to: org }, "hub", site.id, ORG_MOVE_TOKEN_TTL, seen.org);
      const response = await fetch(`${apiBase(site)}/api/org/move`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token })
      }).catch(() => null);
      const data = await response?.json().catch(() => ({})) as { move?: { effectiveAt: number }, error?: string } | undefined;
      if(response?.ok) sites.push({ id: site.id, name: site.name, org: seen.org, state: "requested", effectiveAt: data?.move?.effectiveAt });
      else sites.push({ id: site.id, name: site.name, org: seen.org, state: response ? "refused" : "unreachable", error: data?.error });
    }
  }
  return { org, previous, sites };
}
