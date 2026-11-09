import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Vibe CMS sites running on this machine: the ports something listens on (from `lsof`, `ss` or
 * `netstat`), each asked for the descriptor every site serves at `/.well-known/vibe-cms`.
 */

const run = promisify(execFile);

/** A port something listens on, and what we know of the process. */
export interface Listener {
  /** The address to reach it at: `localhost` for loopback and wildcard listeners, else the address itself. */
  host: string,
  port: number,
  pid?: number,
  command?: string
}

export interface LocalSite {
  /** The site's own ID: the same site can answer on more than one port. */
  id?: string,
  url: string,
  /** The process serving it. */
  pid?: number,
  prefix: string,
  name: string,
  /** Runs in development mode: the CLI signs in without a login. */
  dev: boolean,
  /** The folder the server was started in, as `~/…` when it's under the home folder. */
  folder?: string,
  command?: string
}

export type Discovery =
  | { ok: true, sites: LocalSite[] }
  | { ok: false, reason: string };

/** `127.0.0.1:1340`, `*:1340`, `[::1]:1340`, `0.0.0.0:1340` → where to reach it. */
export function parseAddress(address: string): { host: string, port: number } | null {
  const match = /^(.*):(\d+)$/.exec(address.trim());
  if(!match) return null;
  const port = Number(match[2]);
  if(!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const raw = match[1]!.replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const loopback = ["*", "0.0.0.0", "::", "127.0.0.1", "::1", "localhost", ""].includes(raw) || raw.startsWith("127.") || raw === "::ffff:127.0.0.1";
  return { host: loopback ? "localhost" : raw.includes(":") ? `[${raw}]` : raw, port };
}

/** `lsof -F pcn` output: `p<pid>`, `c<command>`, then an `n<address>` per listening socket. */
export function parseLsof(output: string): Listener[] {
  const listeners: Listener[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for(const line of output.split("\n")) {
    const field = line[0];
    const value = line.slice(1);
    if(field === "p") {
      pid = Number(value);
      command = undefined;
    } else if(field === "c") command = value;
    else if(field === "n") {
      const address = parseAddress(value);
      if(address) listeners.push({ ...address, pid, command });
    }
  }
  return listeners;
}

/** `ss -ltnpH`: `LISTEN 0 511 127.0.0.1:1340 0.0.0.0:* users:(("node",pid=123,fd=21))`. */
export function parseSs(output: string): Listener[] {
  return output.split("\n").flatMap(line => {
    const columns = line.trim().split(/\s+/);
    const address = columns[3] ? parseAddress(columns[3]) : null;
    if(!address) return [];
    const process = /\("([^"]+)",pid=(\d+)/.exec(line);
    return [{ ...address, pid: process ? Number(process[2]) : undefined, command: process?.[1] }];
  });
}

/** `netstat -ano -p tcp` on Windows: `TCP    127.0.0.1:1340    0.0.0.0:0    LISTENING    1234`. */
export function parseNetstat(output: string): Listener[] {
  return output.split("\n").flatMap(line => {
    const columns = line.trim().split(/\s+/);
    if(columns[0] !== "TCP" || columns[3] !== "LISTENING") return [];
    const address = parseAddress(columns[1]!);
    return address ? [{ ...address, pid: Number(columns[4]) || undefined }] : [];
  });
}

/** The ports listening on this machine, or why they couldn't be listed. */
export async function listeners(): Promise<{ ok: true, listeners: Listener[] } | { ok: false, reason: string }> {
  const attempts: Array<[string, string[], (output: string) => Listener[]]> = process.platform === "win32"
    ? [["netstat", ["-ano", "-p", "tcp"], parseNetstat]]
    : [["lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], parseLsof], ["ss", ["-ltnpH"], parseSs]];
  for(const [command, args, parse] of attempts) {
    try {
      const { stdout } = await run(command, args, { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      return { ok: true, listeners: parse(stdout) };
    } catch (error) {
      // lsof exits 1 when nothing listens at all.
      const failed = error as { code?: unknown, stdout?: string };
      if(command === "lsof" && failed.code === 1 && !failed.stdout) return { ok: true, listeners: [] };
    }
  }
  return { ok: false, reason: `Couldn't list the ports open on this machine: ${attempts.map(a => a[0]).join(" and ")} ${attempts.length > 1 ? "aren't" : "isn't"} available.` };
}

/** Where a process was started, so two sites can be told apart. Not on Windows. */
async function folderOf(pid: number | undefined): Promise<string | undefined> {
  if(!pid) return undefined;
  let folder: string | undefined;
  if(process.platform === "linux") folder = await readlink(`/proc/${pid}/cwd`).catch(() => undefined);
  else if(process.platform === "darwin") {
    const output = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"], { timeout: 3000 }).then(r => r.stdout, () => "");
    folder = output.split("\n").find(line => line.startsWith("n"))?.slice(1);
  }
  if(!folder) return undefined;
  const home = os.homedir();
  return folder === home || folder.startsWith(home + path.sep) ? `~${folder.slice(home.length)}` : folder;
}

/** The site at this address, if it is one: its descriptor, and whether it runs in development mode. */
export async function probe(listener: Listener, fetcher: typeof fetch = fetch): Promise<LocalSite | null> {
  const origin = `http://${listener.host}:${listener.port}`;
  try {
    const response = await fetcher(`${origin}/.well-known/vibe-cms`, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    if(!response.ok || !response.headers.get("content-type")?.includes("json")) return null;
    const descriptor = await response.json() as { protocol?: number, id?: string, name?: string | null, admin?: string };
    if(descriptor.protocol !== 1 || typeof descriptor.admin !== "string") return null;
    const prefix = new URL(descriptor.admin).pathname.replace(/\/admin\/?$/, "") || "/_vibe";
    const info: { dev?: boolean } = await fetcher(`${origin}${prefix}/api/info`, { signal: AbortSignal.timeout(1500) })
      .then(r => r.ok ? r.json() as Promise<{ dev?: boolean }> : {}, () => ({}));
    return { ...descriptor.id ? { id: descriptor.id } : {}, url: origin, prefix, name: descriptor.name || `localhost:${listener.port}`, dev: info.dev === true, command: listener.command };
  } catch {
    return null;
  }
}

/** Every Vibe CMS site served from this machine, by port. */
export async function discoverSites(): Promise<Discovery> {
  const found = await listeners();
  if(!found.ok) return found;
  // One server often listens on both 127.0.0.1 and ::1: the same site, asked once.
  const unique = new Map<string, Listener>();
  for(const listener of found.listeners) {
    const key = `${listener.host}:${listener.port}`;
    if(!unique.has(key)) unique.set(key, listener);
  }
  const sites = (await Promise.all([...unique.values()].map(async listener => {
    const site = await probe(listener);
    if(!site) return null;
    const folder = await folderOf(listener.pid);
    // A site nobody has named calls itself by its host; its project's folder says more.
    const unnamed = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(site.name);
    return { ...site, pid: listener.pid, folder, name: unnamed && folder ? path.basename(folder) : site.name };
  }))).filter(site => site !== null);
  // Only needed when a site answers on more than one port.
  const repeated = new Set(sites.map(site => site.id).filter((id, i, ids) => id && ids.indexOf(id) !== i));
  const parents = repeated.size ? await processParents() : new Map<number, number>();
  return { ok: true, sites: onePerSite(sites, parents).sort((a, b) => a.url.localeCompare(b.url, undefined, { numeric: true })) };
}

/** Each process's parent, from `ps` (or PowerShell on Windows). Empty when it can't be read. */
export async function processParents(): Promise<Map<number, number>> {
  const [command, args] = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"]]
    : ["ps", ["-A", "-o", "pid=,ppid="]];
  const output = await run(command, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }).then(r => r.stdout, () => "");
  return parseParents(output);
}

/** `ps -o pid=,ppid=` lines: `  123   1`. */
export function parseParents(output: string): Map<number, number> {
  const parents = new Map<number, number>();
  for(const line of output.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if(pid && ppid !== undefined && !Number.isNaN(ppid)) parents.set(pid, ppid);
  }
  return parents;
}

/** Whether `ancestor` started `pid`, directly or through other processes. */
function descends(pid: number, ancestor: number, parents: Map<number, number>): boolean {
  const seen = new Set<number>();
  for(let at = parents.get(pid); at !== undefined && at > 1 && !seen.has(at); at = parents.get(at)) {
    if(at === ancestor) return true;
    seen.add(at);
  }
  return false;
}

function port(site: LocalSite): number {
  return Number(new URL(site.url).port || 80);
}

/**
 * One entry per server. The same site (by its ID) can answer on more than one port when one server sits
 * in front of another: Astro, Vite's Cloudflare plugin and `wrangler dev` start workerd as a child and
 * forward to it on a port of its own. A site whose process was started by another serving the same site
 * is that server's insides, and goes. One process on several ports is one server: its lowest port stays.
 * Servers that aren't related are separate, even sharing a database, so all of them stay.
 */
export function onePerSite(sites: LocalSite[], parents: Map<number, number>): LocalSite[] {
  return sites.filter(site => !sites.some(other => {
    if(other === site || !site.id || other.id !== site.id || !site.pid || !other.pid) return false;
    if(other.pid === site.pid) return port(other) < port(site);
    return descends(site.pid, other.pid, parents);
  }));
}
