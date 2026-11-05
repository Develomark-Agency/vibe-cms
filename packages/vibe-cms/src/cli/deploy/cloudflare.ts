import { PANEL_MARKER, type HubRecord } from "./state.ts";

export interface ExecResult {
  code: number,
  stdout: string,
  stderr: string
}

/** Runs `wrangler` with these arguments. `stream` shows its output as it runs, for the deploy. */
export type Exec = (args: string[], options?: { cwd?: string, stream?: boolean }) => Promise<ExecResult>;

/** Wrangler through bunx, so it uses the person's own login and nothing here handles credentials by hand. */
export async function wranglerExec(args: string[], { cwd, stream }: { cwd?: string, stream?: boolean } = {}): Promise<ExecResult> {
  const proc = Bun.spawn(["bunx", "wrangler", ...args], { cwd, stdin: stream ? "inherit" : "ignore", stdout: stream ? "inherit" : "pipe", stderr: stream ? "inherit" : "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  const [stdout, stderr, code] = await Promise.all([
    stream ? "" : new Response(proc.stdout as ReadableStream).text(),
    stream ? "" : new Response(proc.stderr as ReadableStream).text(),
    proc.exited
  ]);
  return { code, stdout, stderr };
}

/** The command as the person would type it, for showing before it runs. */
export function show(args: string[]) {
  return `wrangler ${args.join(" ")}`;
}

function json<T>(text: string): T {
  const start = text.search(/[[{]/);
  if(start < 0) throw new Error(`Expected JSON from wrangler, got: ${text.trim().slice(0, 200)}`);
  return JSON.parse(text.slice(start)) as T;
}

export interface Account {
  id: string,
  name: string
}

export interface Whoami {
  email?: string,
  accounts: Account[]
}

/** Who wrangler is logged in as, or null when it isn't. */
export async function whoami(exec: Exec): Promise<Whoami | null> {
  const result = await exec(["whoami", "--json"]);
  if(result.code) return null;
  const data = json<{ loggedIn?: boolean, email?: string, accounts?: Account[] }>(result.stdout);
  if(data.loggedIn === false) return null;
  return { email: data.email, accounts: (data.accounts ?? []).map(a => ({ id: a.id, name: a.name })) };
}

/** Wrangler's own session, for read-only calls to Cloudflare's API that wrangler has no command for. */
export async function authHeaders(exec: Exec): Promise<Record<string, string> | null> {
  const result = await exec(["auth", "token", "--json"]);
  if(result.code) return null;
  try {
    const data = json<{ type?: string, token?: string, key?: string, email?: string }>(result.stdout);
    if(data.token) return { authorization: `Bearer ${data.token}` };
    if(data.key && data.email) return { "x-auth-key": data.key, "x-auth-email": data.email };
  } catch {}
  return null;
}

const API = "https://api.cloudflare.com/client/v4";

/** Read-only calls to Cloudflare's API with the person's wrangler session. Every method says why it failed. */
export class CloudflareApi {
  constructor(private headers: Record<string, string>, private fetcher: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    const response = await this.fetcher(`${API}${path}`, { headers: this.headers });
    const body = await response.json().catch(() => null) as { success?: boolean, result?: T, errors?: Array<{ message: string }> } | null;
    if(!response.ok || !body?.success) throw new Error(body?.errors?.map(e => e.message).join("; ") || `Cloudflare answered ${response.status}`);
    return body.result as T;
  }

  async databases(account: string) {
    return (await this.get<Array<{ uuid: string, name: string }>>(`/accounts/${account}/d1/database?per_page=100`)).map(d => ({ id: d.uuid, name: d.name }));
  }

  async buckets(account: string) {
    return (await this.get<{ buckets: Array<{ name: string }> }>(`/accounts/${account}/r2/buckets`)).buckets.map(b => b.name);
  }

  async workers(account: string) {
    return (await this.get<Array<{ id: string }>>(`/accounts/${account}/workers/scripts`)).map(w => w.id);
  }

  async bindings(account: string, worker: string) {
    return (await this.get<{ bindings?: Binding[] }>(`/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/settings`)).bindings ?? [];
  }

  /** The account's `workers.dev` subdomain, which the Worker's default address hangs off. */
  async subdomain(account: string) {
    return (await this.get<{ subdomain?: string }>(`/accounts/${account}/workers/subdomain`)).subdomain ?? null;
  }

  async domains(account: string, worker: string) {
    return (await this.get<Array<{ hostname: string }>>(`/accounts/${account}/workers/domains?service=${encodeURIComponent(worker)}`)).map(d => d.hostname);
  }

  /** The zone (a domain in this account) a hostname falls under, or null when its DNS isn't on Cloudflare here. */
  async zoneFor(account: string, hostname: string) {
    const labels = hostname.split(".");
    for(let i = 0; i <= labels.length - 2; i++) {
      const name = labels.slice(i).join(".");
      const zones = await this.get<Array<{ id: string, name: string }>>(`/zones?name=${encodeURIComponent(name)}&account.id=${account}`);
      if(zones[0]) return { id: zones[0].id, name: zones[0].name };
    }
    return null;
  }

  async txtRecords(zone: string, name: string) {
    return (await this.get<Array<{ id: string, content: string }>>(`/zones/${zone}/dns_records?type=TXT&name=${encodeURIComponent(name)}`)).map(r => ({ id: r.id, content: r.content.replace(/^"|"$/g, "") }));
  }

  async createTxt(zone: string, name: string, content: string) {
    const response = await this.fetcher(`${API}/zones/${zone}/dns_records`, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "TXT", name, content: `"${content}"`, ttl: 300 })
    });
    const body = await response.json().catch(() => null) as { success?: boolean, errors?: Array<{ message: string }> } | null;
    if(!response.ok || !body?.success) throw new Error(body?.errors?.map(e => e.message).join("; ") || `Cloudflare answered ${response.status}`);
  }
}

export interface Binding {
  type: string,
  name: string,
  text?: string,
  id?: string,
  database_id?: string,
  bucket_name?: string
}

/** A Worker that carries the panel marker, as far as its bindings show. Secrets can't be read back, only their names. */
export interface FoundPanel {
  name: string,
  record: Omit<HubRecord, "accountId" | "accountName" | "database"> & { database: { name: string, id: string } },
  secrets: string[]
}

/**
 * Looks through an account's Workers for panels: the ones with `VIBE_PANEL` set. Workers that can't
 * be read are skipped, since one odd Worker shouldn't hide the panel being looked for.
 */
export async function findPanels(api: CloudflareApi, account: string): Promise<FoundPanel[]> {
  const [names, databases] = await Promise.all([api.workers(account), api.databases(account).catch(() => [])]);
  const found = await Promise.all(names.map(async (name): Promise<FoundPanel | null> => {
    const bindings = await api.bindings(account, name).catch(() => null);
    if(!bindings?.some(b => b.type === "plain_text" && b.name === PANEL_MARKER)) return null;
    const vars: Record<string, string> = {};
    for(const b of bindings) if(b.type === "plain_text" && b.text !== undefined && b.name !== PANEL_MARKER) vars[b.name] = b.text;
    const d1 = bindings.find(b => b.type === "d1" && b.name === "DB");
    const id = d1?.id ?? d1?.database_id ?? "";
    const bucket = bindings.find(b => b.type === "r2_bucket" && b.name === "BACKUPS");
    const domains = await api.domains(account, name).catch(() => [] as string[]);
    const domain = domains[0] ?? null;
    return {
      name,
      secrets: bindings.filter(b => b.type === "secret_text").map(b => b.name),
      record: {
        version: 1,
        name,
        database: { id, name: databases.find(d => d.id === id)?.name ?? id },
        backups: bucket?.bucket_name ?? null,
        vars,
        domain,
        url: domain ? `https://${domain}` : vars.PANEL_URL
      }
    };
  }));
  return found.filter((f): f is FoundPanel => f !== null);
}
