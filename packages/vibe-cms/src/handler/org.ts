import { calculateJwkThumbprint, createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWK, type JWTPayload } from "jose";
import { HttpError } from "../config.ts";
import { normalizeOrg, ORG_MOVE_DELAY_SECONDS, ORG_MOVE_SCOPE, OrgLookupError, resolveHub, type OrgStatus } from "../org/index.ts";
import { getMeta, run } from "./db.ts";
import type { D1 } from "./platform.ts";

/**
 * The org a site trusts, kept in its database.
 *
 * `VIBE_ORG` sets it. A signed move from the hub can change it after a delay; from then on the stored
 * org wins over the unchanged variable. Changing the variable, or setting `VIBE_ORG_RESET`, puts the
 * variable back in charge. Removing the variable keeps the stored org, so a lost variable never opens
 * the site up.
 *
 * The site keeps a copy of its hub's public keys, so it can check a move even when the old org's
 * DNS record or hub is already gone.
 */

export interface OrgEnv {
  VIBE_ORG?: string,
  /** Any value but "" or "0": the site trusts `VIBE_ORG` again, whatever moves it accepted. */
  VIBE_ORG_RESET?: string,
  /** Seconds a move waits before it takes effect. Defaults to 72 hours. */
  VIBE_ORG_MOVE_DELAY?: string
}

interface StoredMove {
  to: string,
  /** The new org's hub keys, checked to include the key that signed the move. */
  keys: JSONWebKeySet,
  hub: string,
  requestedAt: number,
  effectiveAt: number
}

export interface OrgEvent {
  at: number,
  event: "set" | "move-requested" | "move-cancelled" | "moved" | "reset",
  org: string | null,
  to?: string,
  by?: string
}

const KEYS_TTL = 5 * 60_000;
/** Tokens naming an unknown key make the site look again, but no more often than this. */
const REFETCH_INTERVAL = 30_000;

export class SiteOrg {
  #org: string | null = null;
  #move: StoredMove | null = null;
  #keys: { set: JSONWebKeySet, fetchedAt: number } | null = null;
  #lastFetch = 0;
  #delay: number;

  private constructor(private db: D1, env: OrgEnv) {
    const seconds = Number(env.VIBE_ORG_MOVE_DELAY);
    this.#delay = (Number.isFinite(seconds) && seconds >= 0 && env.VIBE_ORG_MOVE_DELAY !== undefined && env.VIBE_ORG_MOVE_DELAY !== "" ? seconds : ORG_MOVE_DELAY_SECONDS) * 1000;
  }

  /** Reads the stored org and reconciles it with the environment. */
  static async load(db: D1, env: OrgEnv): Promise<SiteOrg> {
    const org = new SiteOrg(db, env);
    await org.#reconcile(env);
    return org;
  }

  async #reconcile(env: OrgEnv) {
    const configured = env.VIBE_ORG?.trim() ? normalizeOrg(env.VIBE_ORG) : null;
    if(env.VIBE_ORG?.trim() && !configured) throw new Error(`vibe-cms: VIBE_ORG "${env.VIBE_ORG}" isn't a domain like my-org.com or a URL`);
    const reset = Boolean(env.VIBE_ORG_RESET && env.VIBE_ORG_RESET !== "0");
    const stored = await getMeta(this.db, "org");
    const lastEnv = await getMeta(this.db, "org_env");
    const move = await getMeta(this.db, "org_move");
    this.#move = move ? JSON.parse(move) as StoredMove : null;
    const keys = await getMeta(this.db, "org_keys");
    // A stored copy is only a fallback: it's refreshed from the hub on first use.
    this.#keys = keys ? { set: JSON.parse(keys) as JSONWebKeySet, fetchedAt: 0 } : null;

    if(reset || (configured !== null && configured !== lastEnv)) {
      if(configured !== stored || this.#move) {
        await this.#set(configured, { event: reset ? "reset" : "set", org: configured, at: Date.now() });
      } else {
        this.#org = configured;
      }
      await this.#meta("org_env", configured);
      return;
    }
    if(configured === null && stored !== null) {
      console.warn(`vibe-cms: VIBE_ORG isn't set; this site still trusts ${stored}, as stored in its database. Set VIBE_ORG_RESET=1 to sign out of it.`);
    }
    this.#org = stored;
  }

  /** The org trusted now. A move that came due takes effect here. */
  async current(): Promise<string | null> {
    if(this.#move && this.#move.effectiveAt <= Date.now()) {
      const move = this.#move;
      await this.#set(move.to, { event: "moved", org: this.#org, to: move.to, at: Date.now() });
      this.#keys = { set: move.keys, fetchedAt: 0 };
      await this.#meta("org_keys", JSON.stringify(move.keys));
    }
    return this.#org;
  }

  async status(): Promise<OrgStatus> {
    const org = await this.current();
    let hub: string | null = null;
    if(org) hub = await resolveHub(org).catch(() => null) ?? await getMeta(this.db, "org_hub");
    return {
      org,
      hub,
      move: this.#move ? { to: this.#move.to, requestedAt: this.#move.requestedAt, effectiveAt: this.#move.effectiveAt } : null
    };
  }

  async history(): Promise<OrgEvent[]> {
    return JSON.parse(await getMeta(this.db, "org_history") ?? "[]") as OrgEvent[];
  }

  /**
   * Checks a token the org's hub signed for this site, and returns its claims. Keys come from the hub
   * (looked up through the org), with the stored copy as a fallback when the hub can't be reached.
   */
  async verify(token: string, siteId: string): Promise<JWTPayload | null> {
    const org = await this.current();
    if(!org) return null;
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      return null;
    }
    // Refetch when the copy is old, or doesn't have the token's key (the hub changed keys).
    let keys = await this.#hubKeys(org, !this.#keys || Date.now() - this.#keys.fetchedAt > KEYS_TTL || !hasKey(this.#keys.set, kid));
    if(!keys) return null;
    try {
      const { payload } = await jwtVerify(token, createLocalJWKSet(keys), { issuer: org, audience: siteId, algorithms: ["ES256"] });
      return payload;
    } catch {
      return null;
    }
  }

  async #hubKeys(org: string, refresh: boolean): Promise<JSONWebKeySet | null> {
    if(refresh && Date.now() - this.#lastFetch >= REFETCH_INTERVAL) {
      this.#lastFetch = Date.now();
      const fetched = await fetchKeys(org).catch(() => null);
      if(fetched) {
        const changed = JSON.stringify(fetched.keys) !== JSON.stringify(this.#keys?.set);
        this.#keys = { set: fetched.keys, fetchedAt: Date.now() };
        if(changed) await this.#meta("org_keys", JSON.stringify(fetched.keys));
        await this.#meta("org_hub", fetched.hub);
      }
    }
    return this.#keys?.set ?? null;
  }

  /**
   * A move the hub signed: `iss` is the current org, `to` the new one. The new org's hub has to serve
   * the key that signed it, so the move can't point the site at a hub with different keys. It takes
   * effect after the delay unless someone who can change the site's settings cancels it.
   */
  async requestMove(token: string, siteId: string): Promise<OrgStatus> {
    const org = await this.current();
    if(!org) throw new HttpError(409, "This site doesn't belong to an org");
    const payload = await this.verify(token, siteId);
    if(!payload || payload.scope !== ORG_MOVE_SCOPE) throw new HttpError(401, "Not a move signed by this site's hub");
    const to = normalizeOrg(typeof payload.to === "string" ? payload.to : null);
    if(!to || to === org) throw new HttpError(400, "The move doesn't name another org");
    if(this.#move?.to === to) return this.status();
    const { kid } = decodeProtectedHeader(token);
    const signer = this.#keys?.set.keys.find(key => key.kid === kid);
    let target: { hub: string, keys: JSONWebKeySet };
    try {
      target = await fetchKeys(to, true);
    } catch (error) {
      throw new HttpError(422, error instanceof OrgLookupError ? error.message : `Couldn't reach ${to}'s hub`);
    }
    if(!signer || !await includesKey(target.keys, signer)) throw new HttpError(422, `${to}'s hub doesn't serve the key that signed this move`);
    const now = Date.now();
    this.#move = { to, keys: target.keys, hub: target.hub, requestedAt: now, effectiveAt: now + this.#delay };
    await this.#meta("org_move", JSON.stringify(this.#move));
    await this.#log({ event: "move-requested", org, to, at: now });
    return this.status();
  }

  async cancelMove(by: string): Promise<OrgStatus> {
    const move = this.#move;
    if(!move) throw new HttpError(404, "No move to cancel");
    this.#move = null;
    await this.#meta("org_move", null);
    await this.#log({ event: "move-cancelled", org: this.#org, to: move.to, by, at: Date.now() });
    return this.status();
  }

  async #set(org: string | null, event: OrgEvent) {
    this.#org = org;
    this.#move = null;
    this.#keys = null;
    await this.#meta("org", org);
    await this.#meta("org_move", null);
    await this.#meta("org_keys", null);
    await this.#meta("org_hub", null);
    await this.#log(event);
  }

  async #log(event: OrgEvent) {
    const history = [...await this.history(), event].slice(-50);
    await this.#meta("org_history", JSON.stringify(history));
  }

  async #meta(key: string, value: string | null) {
    if(value === null) await run(this.db, "DELETE FROM vibe_meta WHERE key = ?", [key]);
    else await run(this.db, "INSERT OR REPLACE INTO vibe_meta (key, value) VALUES (?, ?)", [key, value]);
  }
}

function hasKey(set: JSONWebKeySet, kid: string | undefined): boolean {
  return set.keys.some(key => kid === undefined || key.kid === kid);
}

async function includesKey(set: JSONWebKeySet, key: JWK): Promise<boolean> {
  const thumbprint = await calculateJwkThumbprint(key);
  for(const candidate of set.keys) {
    if(await calculateJwkThumbprint(candidate).catch(() => null) === thumbprint) return true;
  }
  return false;
}

async function fetchKeys(org: string, fresh = false): Promise<{ hub: string, keys: JSONWebKeySet }> {
  const hub = await resolveHub(org, { fresh });
  const response = await fetch(`${hub}/.well-known/jwks.json`);
  if(!response.ok) throw new OrgLookupError(`${hub} didn't serve its keys (${response.status})`);
  const keys = await response.json() as JSONWebKeySet;
  if(!Array.isArray(keys?.keys)) throw new OrgLookupError(`${hub} didn't serve a key set`);
  return { hub, keys };
}
