import { pkceChallenge, randomString } from "../oidc/index.ts";

/**
 * An OAuth 2.1 authorization server for agents (MCP clients) and the CLI: discovery, dynamic client
 * registration (RFC 7591), authorization codes with S256 PKCE, rotating refresh tokens, revocation
 * (RFC 7009). The hub and sites without an org each run one; they differ only in what's plugged in:
 *
 * - where its tables live (a prefix) and what its tokens start with;
 * - how the user approves: the caller validates a request here, then asks the user however it likes,
 *   and calls `approve` or `deny` with the answer;
 * - what a connection carries (`payload`, opaque here) and what its tokens turn into, which the caller
 *   works out from the grant `grantFor` returns.
 *
 * Codes and tokens are stored as hashes, so a leaked database doesn't leak working credentials.
 */

/** Everything the user can reach. */
export const SCOPE_WRITE = "content";
/** Only what reads. */
export const SCOPE_READ = "content:read";
const SCOPES = [SCOPE_WRITE, SCOPE_READ];

const ACCESS_TTL = 3600 * 1000;
const REFRESH_TTL = 30 * 24 * 3600 * 1000;
const CODE_TTL = 60 * 1000;
const REQUEST_TTL = 10 * 60 * 1000;

/** The parts of a D1 database this uses; the hub's and a site's both fit. */
export interface OAuthStatement {
  bind(...values: unknown[]): OAuthStatement,
  first(): Promise<unknown>,
  run(): Promise<unknown>,
  all(): Promise<{ results?: unknown[] }>
}

export interface OAuthDb {
  prepare(query: string): OAuthStatement,
  batch(statements: never[]): Promise<unknown>
}

/** The tables, named `<prefix>oauth_clients` and so on. Add them to the database's schema. */
export function oauthSchema(prefix: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${prefix}oauth_clients (
      id TEXT PRIMARY KEY,
      secret_hash TEXT,
      name TEXT NOT NULL,
      uri TEXT,
      redirect_uris TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    // An authorization in progress: from the client's /oauth/authorize to the user's answer.
    `CREATE TABLE IF NOT EXISTS ${prefix}oauth_requests (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL,
      state TEXT,
      scope TEXT NOT NULL,
      user TEXT,
      expires_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${prefix}oauth_codes (
      hash TEXT PRIMARY KEY,
      grant_id TEXT NOT NULL,
      client_id TEXT NOT NULL,
      redirect_uri TEXT NOT NULL,
      challenge TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`,
    // A connection: who approved it, what it may do, and whatever the server keeps with it (`payload`).
    `CREATE TABLE IF NOT EXISTS ${prefix}oauth_grants (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      user TEXT NOT NULL,
      payload TEXT NOT NULL,
      scope TEXT NOT NULL,
      access_hash TEXT UNIQUE,
      access_expires_at INTEGER,
      refresh_hash TEXT UNIQUE,
      refresh_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    )`
  ];
}

export interface ClientRow {
  id: string,
  secret_hash: string | null,
  name: string,
  uri: string | null,
  redirect_uris: string,
  auth_method: "none" | "client_secret_post" | "client_secret_basic",
  created_at: number
}

export interface RequestRow {
  id: string,
  client_id: string,
  redirect_uri: string,
  challenge: string,
  state: string | null,
  scope: string,
  user: string | null,
  expires_at: number
}

export interface GrantRow {
  id: string,
  client_id: string,
  user: string,
  payload: string,
  scope: string,
  access_hash: string | null,
  access_expires_at: number | null,
  refresh_hash: string | null,
  refresh_expires_at: number | null,
  created_at: number,
  last_used_at: number | null
}

export interface OAuthOptions {
  db: OAuthDb,
  /** Table name prefix: `""` for the hub, `"vibe_"` for a site. */
  tables: string,
  /** Token and id prefix, e.g. `"vp"`: clients are `vpc_…`, access tokens `vpa_…`, refresh tokens `vpr_…`. */
  tokens: string,
  /** The server's issuer for a request's URL; its endpoints are `<issuer>/oauth/…`. */
  issuer(url: URL): string,
  /** The protected resource (the MCP endpoint) tokens are for. */
  resource(url: URL): string,
  /** Where the protected resource metadata is, for the 401's `WWW-Authenticate`. */
  resourceMetadata(url: URL): string,
  /** Called before a grant is deleted, to remove whatever the server keeps with it. */
  onRemove?(grant: GrantRow): OAuthStatement[]
}

/** Discovery documents and the token endpoint are called from browser-based clients too. */
export const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version" };

function json(data: unknown, init: ResponseInit = {}): Response {
  return Response.json(data, { ...init, headers: { "cache-control": "no-store", ...CORS, ...init.headers } });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, { status });
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Loopback over http, https, or an app's own scheme. Never something a browser would run. */
function validRedirect(uri: unknown): uri is string {
  if(typeof uri !== "string" || !URL.canParse(uri)) return false;
  const parsed = new URL(uri);
  if(parsed.hash) return false;
  if(parsed.protocol === "https:") return true;
  if(parsed.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return !["javascript:", "data:", "file:", "vbscript:", "about:", "blob:"].includes(parsed.protocol);
}

/** A checked authorize request, ready to keep while the user decides. */
export interface AuthorizeParams {
  client: ClientRow,
  redirectUri: string,
  challenge: string,
  state: string | null,
  /** The client asked only for the read scope. */
  readOnlyOnly: boolean
}

/** The page a headless CLI login lands on, showing the code to paste with its state. */
export function codePage(url: URL): Response {
  function escape(text: string) {
    return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
  }
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" };
  function shell(body: string) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>vibe-cms</title><body style="font:15px/1.5 system-ui;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px"><main style="max-width:480px;text-align:center">${body}</main>`;
  }
  if(!code) return new Response(shell(`<h1 style="font-size:20px">Not connected</h1><p>${escape(error ?? "No code here.")}</p>`), { status: 400, headers });
  // The state rides along, so the CLI can check the pasted code is the one it asked for.
  const value = escape(`${code}.${url.searchParams.get("state") ?? ""}`);
  return new Response(shell(`<h1 style="font-size:20px">Paste this code in your terminal</h1>
<p><code id="code" style="display:block;word-break:break-all;font-size:14px;padding:12px;border:1px solid #8884;border-radius:10px;user-select:all">${value}</code></p>
<button onclick="navigator.clipboard.writeText(document.getElementById('code').textContent);this.textContent='Copied'" style="font:inherit;padding:8px 16px;border-radius:10px;border:1px solid #8884;background:none;color:inherit;cursor:pointer">Copy</button>
<p style="opacity:.7">It works once, for a minute.</p>`), { headers });
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-allow-methods": "GET, POST, OPTIONS" } });
}

export class OAuthServer {
  constructor(private options: OAuthOptions) {}

  #t(name: string) {
    return `${this.options.tables}${name}`;
  }

  get #db() {
    return this.options.db;
  }

  protectedResourceMetadata(url: URL, name: string): Response {
    return json({
      resource: this.options.resource(url),
      authorization_servers: [this.options.issuer(url)],
      scopes_supported: SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: name
    });
  }

  authorizationServerMetadata(url: URL): Response {
    const base = this.options.issuer(url);
    return json({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      scopes_supported: SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      authorization_response_iss_parameter_supported: true
    });
  }

  /** What a client without a valid token gets from the protected resource: where to find out how to sign in. */
  unauthorized(url: URL, invalid: boolean): Response {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: `Sign in to use ${this.options.resource(url)}` } },
      {
        status: 401,
        headers: {
          "www-authenticate": `Bearer resource_metadata="${this.options.resourceMetadata(url)}"${invalid ? ", error=\"invalid_token\"" : ""}`,
          "access-control-expose-headers": "www-authenticate"
        }
      }
    );
  }

  /** RFC 7591 dynamic client registration: agents and the CLI add themselves. */
  async register(request: Request): Promise<Response> {
    let input: Record<string, unknown>;
    try {
      input = await request.json() as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Expected a JSON body");
    }
    const redirects = input.redirect_uris;
    if(!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10 || !redirects.every(validRedirect)) {
      return oauthError("invalid_redirect_uri", "redirect_uris must be https, loopback http, or an app scheme");
    }
    const method = (input.token_endpoint_auth_method ?? "client_secret_basic") as ClientRow["auth_method"];
    if(!["none", "client_secret_post", "client_secret_basic"].includes(method)) return oauthError("invalid_client_metadata", "Unsupported token_endpoint_auth_method");
    const grants = (input.grant_types ?? ["authorization_code"]) as unknown[];
    if(!Array.isArray(grants) || grants.some(g => g !== "authorization_code" && g !== "refresh_token")) {
      return oauthError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
    }
    const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim().slice(0, 100) : "An agent";
    const uri = typeof input.client_uri === "string" && input.client_uri.startsWith("https://") ? input.client_uri : null;
    const id = `${this.options.tokens}c_${randomString(16)}`;
    const secret = method === "none" ? null : `${this.options.tokens}s_${randomString(32)}`;
    await this.#db.prepare(`INSERT INTO ${this.#t("oauth_clients")} (id, secret_hash, name, uri, redirect_uris, auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, secret ? await sha256(secret) : null, name, uri, JSON.stringify(redirects), method, Date.now()).run();
    return json({
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      ...(uri ? { client_uri: uri } : {}),
      redirect_uris: redirects,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    }, { status: 201 });
  }

  async client(id: string | null): Promise<ClientRow | null> {
    if(!id) return null;
    return this.#db.prepare(`SELECT * FROM ${this.#t("oauth_clients")} WHERE id = ?`).bind(id).first() as Promise<ClientRow | null>;
  }

  /** The client's return address with these parameters, and `iss` (RFC 9207). */
  redirect(url: URL, uri: string, params: Record<string, string | null | undefined>): string {
    const target = new URL(uri);
    for(const [key, value] of Object.entries(params)) if(value) target.searchParams.set(key, value);
    target.searchParams.set("iss", this.options.issuer(url));
    return target.toString();
  }

  /**
   * Checks `GET <issuer>/oauth/authorize`. Problems with the client or its return address come back
   * as `{ problem }` for the caller to show (never a redirect); other problems go back to the client.
   */
  async validate(url: URL): Promise<AuthorizeParams | { problem: "unknown-client" | "bad-redirect" } | { response: Response }> {
    const q = url.searchParams;
    const found = await this.client(q.get("client_id"));
    if(!found) return { problem: "unknown-client" };
    const redirects = JSON.parse(found.redirect_uris) as string[];
    const redirectUri = q.get("redirect_uri") ?? (redirects.length === 1 ? redirects[0]! : null);
    // Never redirect to an address the client didn't register.
    if(!redirectUri || !redirects.includes(redirectUri)) return { problem: "bad-redirect" };
    const back = (error: string, description: string) => ({ // eslint-disable-line func-style -- needs `this`
      response: new Response(null, { status: 302, headers: { location: this.redirect(url, redirectUri, { error, error_description: description, state: q.get("state") }), "cache-control": "no-store" } })
    });
    if(q.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
    const challenge = q.get("code_challenge");
    if(!challenge || q.get("code_challenge_method") !== "S256") return back("invalid_request", "PKCE with S256 is required");
    const resource = q.get("resource")?.replace(/\/$/, "");
    if(resource && ![this.options.resource(url), this.options.issuer(url), url.origin].includes(resource)) {
      return back("invalid_target", `This server only issues tokens for ${this.options.resource(url)}`);
    }
    const requested = (q.get("scope") ?? "").split(/\s+/).filter(Boolean);
    return { client: found, redirectUri, challenge, state: q.get("state"), readOnlyOnly: requested.length > 0 && requested.every(s => s === SCOPE_READ) };
  }

  /** Keeps a validated request while the user decides; `user` when it's already known who must answer. */
  async saveRequest(params: AuthorizeParams, user?: string): Promise<string> {
    const id = randomString(16);
    await this.#db.prepare(`DELETE FROM ${this.#t("oauth_requests")} WHERE expires_at < ?`).bind(Date.now()).run();
    await this.#db.prepare(`INSERT INTO ${this.#t("oauth_requests")} (id, client_id, redirect_uri, challenge, state, scope, user, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, params.client.id, params.redirectUri, params.challenge, params.state, params.readOnlyOnly ? SCOPE_READ : SCOPE_WRITE, user ?? null, Date.now() + REQUEST_TTL).run();
    return id;
  }

  /** A request still awaiting an answer, with its client. */
  async pending(id: unknown): Promise<{ request: RequestRow, client: ClientRow } | null> {
    if(typeof id !== "string") return null;
    const request = await this.#db.prepare(`SELECT * FROM ${this.#t("oauth_requests")} WHERE id = ?`).bind(id).first() as RequestRow | null;
    if(!request || request.expires_at < Date.now()) return null;
    const found = await this.client(request.client_id);
    return found ? { request, client: found } : null;
  }

  /** Makes a pending request read only, when the user ticked that. */
  async limitToReading(id: string) {
    await this.#db.prepare(`UPDATE ${this.#t("oauth_requests")} SET scope = ? WHERE id = ?`).bind(SCOPE_READ, id).run();
  }

  /** The user said no: the request is gone, and the client hears `access_denied`. */
  async deny(url: URL, id: string): Promise<string | null> {
    const request = await this.#db.prepare(`DELETE FROM ${this.#t("oauth_requests")} WHERE id = ? RETURNING *`).bind(id).first() as RequestRow | null;
    if(!request) return null;
    return this.redirect(url, request.redirect_uri, { error: "access_denied", error_description: "The user cancelled", state: request.state });
  }

  /**
   * The user said yes: a grant for `user`, carrying `payload`, and a code for the client. Returns where the
   * browser goes next, or null for a request that's gone, expired, or was meant for someone else.
   */
  async approve(url: URL, id: string, answer: { user: string, payload: string, readOnly?: boolean }): Promise<string | null> {
    const request = await this.#db.prepare(`DELETE FROM ${this.#t("oauth_requests")} WHERE id = ? RETURNING *`).bind(id).first() as RequestRow | null;
    if(!request || request.expires_at < Date.now()) return null;
    if(request.user && request.user !== answer.user) {
      return this.redirect(url, request.redirect_uri, { error: "access_denied", error_description: "Signed in as a different account", state: request.state });
    }
    const grantId = `${this.options.tokens}g_${randomString(16)}`;
    const code = randomString(32);
    const now = Date.now();
    const db = this.#db;
    await db.batch(<never[]>[
      db.prepare(`DELETE FROM ${this.#t("oauth_grants")} WHERE refresh_hash IS NULL AND created_at < ?`).bind(now - REQUEST_TTL),
      db.prepare(`INSERT INTO ${this.#t("oauth_grants")} (id, client_id, user, payload, scope, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(grantId, request.client_id, answer.user, answer.payload, answer.readOnly ? SCOPE_READ : request.scope, now),
      db.prepare(`INSERT INTO ${this.#t("oauth_codes")} (hash, grant_id, client_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(await sha256(code), grantId, request.client_id, request.redirect_uri, request.challenge, now + CODE_TTL)
    ]);
    return this.redirect(url, request.redirect_uri, { code, state: request.state });
  }

  /** Client authentication at the token endpoint, by the method the client registered. */
  async #authenticate(request: Request, form: URLSearchParams): Promise<ClientRow | null> {
    const header = request.headers.get("authorization");
    let id = form.get("client_id");
    let secret = form.get("client_secret");
    if(header?.startsWith("Basic ")) {
      const [user, pass] = atob(header.slice(6)).split(":").map(decodeURIComponent);
      id = user ?? null;
      secret = pass ?? null;
    }
    const found = await this.client(id);
    if(!found) return null;
    if(found.auth_method === "none") return found;
    if(!secret || !found.secret_hash || (await sha256(secret)) !== found.secret_hash) return null;
    return found;
  }

  async #issue(grant: Pick<GrantRow, "id" | "scope">): Promise<Response> {
    const access = `${this.options.tokens}a_${randomString(32)}`;
    const refresh = `${this.options.tokens}r_${randomString(32)}`;
    const now = Date.now();
    await this.#db.prepare(`UPDATE ${this.#t("oauth_grants")} SET access_hash = ?, access_expires_at = ?, refresh_hash = ?, refresh_expires_at = ? WHERE id = ?`)
      .bind(await sha256(access), now + ACCESS_TTL, await sha256(refresh), now + REFRESH_TTL, grant.id).run();
    return json({ access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope: grant.scope }, { headers: { pragma: "no-cache" } });
  }

  /** `POST <issuer>/oauth/token`: codes and refresh tokens in, access tokens out. Refresh tokens rotate. */
  async token(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const found = await this.#authenticate(request, form);
    if(!found) return oauthError("invalid_client", "Unknown client or wrong secret", 401);
    const grants = this.#t("oauth_grants");
    if(form.get("grant_type") === "authorization_code") {
      const code = await this.#db.prepare(`DELETE FROM ${this.#t("oauth_codes")} WHERE hash = ? RETURNING *`).bind(await sha256(form.get("code") ?? ""))
        .first() as { grant_id: string, client_id: string, redirect_uri: string, challenge: string, expires_at: number } | null;
      if(!code || code.expires_at < Date.now() || code.client_id !== found.id) return oauthError("invalid_grant", "Unknown or expired code");
      if(form.get("redirect_uri") && form.get("redirect_uri") !== code.redirect_uri) return oauthError("invalid_grant", "redirect_uri doesn't match");
      const verifier = form.get("code_verifier");
      if(!verifier || (await pkceChallenge(verifier)) !== code.challenge) return oauthError("invalid_grant", "PKCE verification failed");
      const grant = await this.#db.prepare(`SELECT * FROM ${grants} WHERE id = ?`).bind(code.grant_id).first() as GrantRow | null;
      if(!grant) return oauthError("invalid_grant", "This connection was removed");
      return this.#issue(grant);
    }
    if(form.get("grant_type") === "refresh_token") {
      const grant = await this.#db.prepare(`SELECT * FROM ${grants} WHERE refresh_hash = ?`).bind(await sha256(form.get("refresh_token") ?? "")).first() as GrantRow | null;
      if(!grant || grant.client_id !== found.id || (grant.refresh_expires_at ?? 0) < Date.now()) return oauthError("invalid_grant", "Unknown or expired refresh token");
      return this.#issue(grant);
    }
    return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
  }

  /** `POST <issuer>/oauth/revoke` (RFC 7009): the whole connection goes. 200 for unknown tokens too, so it can't probe. */
  async revoke(request: Request): Promise<Response> {
    const form = new URLSearchParams(await request.text());
    const found = await this.#authenticate(request, form);
    if(!found) return oauthError("invalid_client", "Unknown client or wrong secret", 401);
    const hash = await sha256(form.get("token") ?? "");
    const grant = await this.#db.prepare(`SELECT * FROM ${this.#t("oauth_grants")} WHERE (access_hash = ? OR refresh_hash = ?) AND client_id = ?`)
      .bind(hash, hash, found.id).first() as GrantRow | null;
    if(grant) await this.remove(grant);
    return new Response(null, { status: 200, headers: CORS });
  }

  /** The grant behind an access token, if it's still valid. Marks it used, at most once a minute. */
  async grantFor(accessToken: string | null | undefined): Promise<GrantRow | null> {
    if(!accessToken?.startsWith(`${this.options.tokens}a_`)) return null;
    const grant = await this.#db.prepare(`SELECT * FROM ${this.#t("oauth_grants")} WHERE access_hash = ?`).bind(await sha256(accessToken)).first() as GrantRow | null;
    if(!grant || (grant.access_expires_at ?? 0) < Date.now()) return null;
    if(!grant.last_used_at || grant.last_used_at < Date.now() - 60_000) {
      await this.#db.prepare(`UPDATE ${this.#t("oauth_grants")} SET last_used_at = ? WHERE id = ?`).bind(Date.now(), grant.id).run();
    }
    return grant;
  }

  /** The grant behind a request's `Authorization: Bearer`. */
  grantForRequest(request: Request): Promise<GrantRow | null> {
    const header = request.headers.get("authorization");
    return this.grantFor(header?.startsWith("Bearer ") ? header.slice(7) : null);
  }

  /** One of a user's grants, by id. */
  async userGrant(user: string, id: string): Promise<GrantRow | null> {
    return this.#db.prepare(`SELECT * FROM ${this.#t("oauth_grants")} WHERE id = ? AND user = ?`).bind(id, user).first() as Promise<GrantRow | null>;
  }

  /** Removes a connection, and whatever the server keeps with it. */
  async remove(grant: GrantRow) {
    const db = this.#db;
    await db.batch(<never[]>[
      ...this.options.onRemove?.(grant) ?? [],
      db.prepare(`DELETE FROM ${this.#t("oauth_codes")} WHERE grant_id = ?`).bind(grant.id),
      db.prepare(`DELETE FROM ${this.#t("oauth_grants")} WHERE id = ?`).bind(grant.id)
    ]);
  }

  /** The connections a user made, newest first. */
  async list(user: string) {
    const { results = [] } = await this.#db.prepare(
      `SELECT g.id, g.scope, g.created_at, g.last_used_at, c.name FROM ${this.#t("oauth_grants")} g
       JOIN ${this.#t("oauth_clients")} c ON c.id = g.client_id
       WHERE g.user = ? AND g.refresh_hash IS NOT NULL ORDER BY g.created_at DESC`
    ).bind(user).all() as { results?: Array<{ id: string, scope: string, created_at: number, last_used_at: number | null, name: string }> };
    return results.map(row => ({ id: row.id, name: row.name, readOnly: row.scope === SCOPE_READ, connectedAt: row.created_at, lastUsedAt: row.last_used_at }));
  }
}
