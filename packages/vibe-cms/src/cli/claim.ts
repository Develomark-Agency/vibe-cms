import { authHeaders, CloudflareApi, whoami, wranglerExec, type Account, type Exec } from "./deploy/cloudflare.ts";

/**
 * A new site's claim link, for someone who missed it in the site's logs. The site makes (or re-prints) the
 * link when asked; the token itself is only ever in the site's own database, so it's read from there through
 * Cloudflare: from the site's address to the Worker that serves it, to that Worker's D1 database.
 */

export interface ClaimLookup {
  accounts: Account[],
  api: Pick<CloudflareApi, "workers" | "subdomain" | "allDomains" | "bindings" | "d1Query">,
  fetch?: (input: string, init?: RequestInit) => Promise<Response>,
  /** Shows progress. */
  say?: (message: string) => void
}

export interface ClaimOptions {
  /** The Worker's name, when it can't be worked out from the address. */
  worker?: string,
  /** The D1 binding to read, when the Worker has several and none is called DB. */
  binding?: string
}

/** The site's address as an origin: `client.com` is `https://client.com`. */
export function siteOrigin(input: string): string {
  const text = input.trim();
  const url = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  if(!URL.canParse(url)) throw new Error(`"${input}" isn't a site address like https://client.com`);
  return new URL(url).origin;
}

/** The Worker that serves an address: a `workers.dev` address names it, a custom domain is looked up. */
export async function findWorker(lookup: ClaimLookup, host: string, options: ClaimOptions = {}): Promise<{ account: string, worker: string }> {
  const onlyAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  const accounts = lookup.accounts.filter(a => !onlyAccount || a.id === onlyAccount);
  for(const account of accounts) {
    if(options.worker) {
      if((await lookup.api.workers(account.id).catch((): string[] => [])).includes(options.worker)) return { account: account.id, worker: options.worker };
      continue;
    }
    const labels = host.split(".");
    if(host.endsWith(".workers.dev") && labels.length >= 4) {
      if(await lookup.api.subdomain(account.id).catch(() => null) === labels.at(-3)) return { account: account.id, worker: labels.slice(0, -3).join(".") };
      continue;
    }
    const domain = (await lookup.api.allDomains(account.id).catch(() => [])).find(d => d.hostname === host);
    if(domain) return { account: account.id, worker: domain.worker };
  }
  throw new Error(options.worker
    ? `No Worker called ${options.worker} in ${accounts.length === 1 ? "this Cloudflare account" : "your Cloudflare accounts"}.`
    : `Couldn't find which Worker serves ${host} in ${accounts.length === 1 ? `the Cloudflare account ${accounts[0]!.name}` : "your Cloudflare accounts"}. Is wrangler logged in to the right account? Pass --worker <name> if the site is routed in some other way.`);
}

/** The D1 database a Worker uses for the CMS: its only one, or the one bound as DB. */
export async function findDatabase(lookup: ClaimLookup, account: string, worker: string, options: ClaimOptions = {}): Promise<string> {
  const bindings = (await lookup.api.bindings(account, worker)).filter(b => b.type === "d1");
  if(!bindings.length) throw new Error(`${worker} has no D1 database bound to it.`);
  const chosen = options.binding ? bindings.find(b => b.name === options.binding) : bindings.length === 1 ? bindings[0] : bindings.find(b => b.name === "DB");
  if(!chosen) {
    throw new Error(options.binding
      ? `${worker} has no D1 binding called ${options.binding} (it has ${bindings.map(b => b.name).join(", ")}).`
      : `${worker} has several D1 databases (${bindings.map(b => b.name).join(", ")}). Pass --binding <name> for the one the CMS uses.`);
  }
  const id = chosen.id ?? chosen.database_id;
  if(!id) throw new Error(`Couldn't read the ID of ${worker}'s ${chosen.name} database.`);
  return id;
}

/**
 * The link to hand to the panel. Asks the site to make its claim token (and print the links to its logs),
 * then reads the token from the site's database.
 */
export async function claimLinkFor(site: string, lookup: ClaimLookup, options: ClaimOptions = {}): Promise<string> {
  const origin = siteOrigin(site);
  const call = lookup.fetch ?? fetch;
  lookup.say?.(`Asking ${origin} for its claim link…`);
  const response = await call(`${origin}/_vibe/api/org/announce`, { method: "POST" }).catch(() => null);
  if(!response) throw new Error(`Couldn't reach ${origin}.`);
  const reply = response.ok ? await response.json().catch(() => null) as { announced?: boolean, reason?: string } | null : null;
  if(!reply || typeof reply.announced !== "boolean") {
    throw new Error(response.status === 404
      ? `${origin} doesn't answer to claim links. It was probably deployed before they existed: redeploy it, then try again.`
      : `${origin} didn't answer the way a Vibe CMS site does (${response.status}).`);
  }
  // A site that printed its links a moment ago has its token already.
  if(!reply.announced && !reply.reason?.startsWith("Printed a moment ago")) throw new Error(`${reply.reason ?? "The site wouldn't make a claim link"}.`);

  lookup.say?.("Finding its database through Cloudflare…");
  const { account, worker } = await findWorker(lookup, new URL(origin).hostname, options);
  const database = await findDatabase(lookup, account, worker, options);
  const rows = await lookup.api.d1Query(account, database, "SELECT value FROM vibe_meta WHERE key = ?", ["org_claim"]);
  const token = rows[0]?.value;
  if(typeof token !== "string" || !token) throw new Error(`${worker}'s database has no claim link. Is ${origin} the site that uses it?`);
  return `${origin}/_vibe/admin/#claim=${token}`;
}

/** Wrangler's own login, for the lookup. */
export async function connect(exec: Exec = wranglerExec, say?: (message: string) => void): Promise<ClaimLookup> {
  const who = await whoami(exec);
  if(!who) throw new Error("Wrangler isn't logged in to Cloudflare. Run `wrangler login`.");
  const headers = await authHeaders(exec);
  if(!headers) throw new Error("Couldn't read wrangler's login. Run `wrangler login` again.");
  return { accounts: who.accounts, api: new CloudflareApi(headers), say };
}
